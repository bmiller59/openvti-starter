// The HCP agent client: the Context Client's side of hcp/* over TSP.
//
//   requestGrant  hcp/grants/request, held with trust-task-next-step while the
//                 person decides, resubmitted on the same thread (HCP 6.1.6)
//   resubmit      one resubmission on a thread: after approval, a new token
//                 under the same grant (earlier tokens stay valid)
//   query         hcp/entries/query under the grant's token (HCP 5.2.1, 7)
//   receive       hcp/grants/revoked pushed by the provider: deduplicate on
//                 noticeId, purge, acknowledge (HCP 6.2.3, 9.9)
//
// Every document the client issues is signed with `proofPurpose:
// authentication` and sealed as a Direct TSP 1.0 message. Every reply is
// checked before use: from the provider, on the thread, signed (unless the
// library pipeline built it), with an authentication proof that verifies, and
// valid against its schema.
//
// The access token stays inside this module and the wallet. Nothing this class
// returns carries it (HCP 10.5); see tools.ts for the model-facing layer.

import { rejectWith, respondWith, type ProofVerifier, type TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import { DataIntegrityProofVerifier, signTrustTask } from "@openvtc/trust-tasks-proof";
import { TspConsumer, packTrustTask, unpackTrustTask } from "@openvtc/trust-tasks-tsp";
import * as discovery from "@openvtc/trust-tasks/trust-task-discovery/0.4/payload";
import * as error from "@openvtc/trust-tasks/trust-task-error/0.6/payload";
import * as nextStep from "@openvtc/trust-tasks/trust-task-next-step/0.1/payload";

import { iso, randomId, systemClock, type Clock, type NewId } from "./clock.js";
import { pairingFor, type AgentIdentity, type Pairing, type PeerKeys } from "./identity.js";
import type { Carrier } from "./transport.js";
import { HcpEntriesQuery_v0_1 as query, HcpGrantsRequest_v0_1 as grantRequest, HcpGrantsRevoked_v0_1 as revoked } from "./trust-tasks/index.js";
import { retryAfterOf, schemaValidator, validateReply } from "./validate.js";
import { Wallet, type Copy, type GrantObject, type GrantView } from "./wallet.js";

export type GrantAsk = grantRequest.Payload;

/** The proof purpose every hcp/* proof carries, both ways (VTI design, question 53). */
export const PROOF_PURPOSE = "authentication";

/** The longest a disclosed copy may be used, from the response that disclosed it (V0 `maxUseSeconds`). */
export const MAX_USE_SECONDS = 3600;

/** How long a processed `noticeId` is remembered (hcp/grants/revoked "Deduplication": at least 25 hours). */
export const NOTICE_RETENTION_SECONDS = 25 * 3600;

/** The codes the receiving end's SPEC §7.2 pipeline raises before any handler runs; the library sends them unsigned. */
export const PIPELINE_CODES: ReadonlySet<string> = new Set([
  "malformedRequest",
  "unsupportedType",
  "unsupportedVersion",
  "unsupportedExtension",
  "expired",
  "proofRequired",
  "proofInvalid",
  "wrongRecipient",
  "identityMismatch",
  "idConflict",
]);

/** Where a grant request stands. */
export type GrantOutcome =
  | { kind: "granted"; threadId: string; grantId: string; grant: GrantObject; tokenExpiresAt: string; tokenCount: number }
  | { kind: "held"; threadId: string; retryAfter: number }
  | { kind: "refused"; threadId: string; code: string; message: string };

/** A disclosed entry as the client returns it: no token, provider order kept. */
export interface DisclosedEntry {
  ref: string;
  text?: string;
  categories: string[];
  /** The provider's `useUntil`, capped at min(response + 1 h, grant `expiresAt`). */
  useUntil: string;
}

export type QueryOutcome =
  | {
      kind: "entries";
      grantId: string;
      purpose: string;
      retrievalId: string;
      /** In the provider's relevance order; never filtered, reordered or padded by the client. */
      entries: DisclosedEntry[];
      categoriesSearched: string[];
      minimization: unknown;
      /** For the host to apply in code, never to place in a model's context (HCP 6.4, 10.5). */
      directives: unknown[];
    }
  | { kind: "refused"; grantId: string; code: string; message: string; grantForgotten: boolean }
  | { kind: "no-grant"; grantId: string };

export interface QueryInput {
  query: string;
  purpose: string;
  categories?: string[];
  maxEntries?: number;
}

/** A notice the client has processed, kept as its record of why it stopped. */
export interface ProcessedNotice {
  noticeId: string;
  grantId: string;
  revokedAt: string;
  processedAt: number;
  /** The signed notice, as received. */
  notice: TrustTaskDocument<revoked.Payload>;
}

/** Hooks for code that watches the traffic (logs, a transcript). They see whole documents: never feed them to a model. */
export interface Observer {
  /** A request the client is about to seal and send. */
  sent?(doc: TrustTaskDocument<unknown>): void;
  /** A reply to one of the client's requests, after it passed every check. */
  received?(doc: TrustTaskDocument<unknown>): void;
  /** A notice the provider pushed, as opened (before the pipeline runs). */
  notice?(doc: TrustTaskDocument<unknown>): void;
}

export interface HcpAgentClientOptions {
  identity: AgentIdentity;
  /** The provider (the person's VTA): its VID and TSP public keys. */
  provider: PeerKeys;
  /** Carries a sealed request to the provider and returns the sealed reply. */
  carrier: Carrier;
  clock?: Clock;
  newId?: NewId;
  /** Verifies proofs on replies and notices. Defaults to the did:key Data Integrity verifier. */
  proofVerifier?: ProofVerifier;
  /** Stop waiting on a held request after this many seconds (default 600). */
  maxHoldSeconds?: number;
  observer?: Observer;
  /** Called once a notice has been processed (not on a duplicate). */
  onRevoked?(notice: ProcessedNotice): void;
}

export interface RequestGrantOptions {
  /** The VTA's DID for the pairing QR. Defaults to the provider's VID. */
  vtaDid?: string;
  /** Called with the pairing before the first document is sent, to show the QR and the number. */
  onPairing?(pairing: Pairing): void | Promise<void>;
  /** Called on each hold, before the client waits and resubmits. */
  onHeld?(held: { threadId: string; attempt: number; retryAfter: number }): void | Promise<void>;
  maxHoldSeconds?: number;
}

interface Thread {
  ask: GrantAsk;
}

export class HcpAgentClient {
  readonly vid: string;
  private readonly identity: AgentIdentity;
  private readonly provider: PeerKeys;
  private readonly carrier: Carrier;
  private readonly clock: Clock;
  private readonly newId: NewId;
  private readonly verifier: ProofVerifier;
  private readonly maxHoldSeconds: number;
  private readonly observer: Observer;
  private readonly onRevoked?: (notice: ProcessedNotice) => void;
  private readonly wallet = new Wallet();
  private readonly threads = new Map<string, Thread>();
  private readonly notices = new Map<string, ProcessedNotice>();
  private readonly consumer: TspConsumer;

  constructor(options: HcpAgentClientOptions) {
    this.identity = options.identity;
    this.vid = options.identity.vid;
    this.provider = options.provider;
    this.carrier = options.carrier;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? randomId;
    this.verifier = options.proofVerifier ?? new DataIntegrityProofVerifier({ now: () => this.clock.now() });
    this.maxHoldSeconds = options.maxHoldSeconds ?? 600;
    this.observer = options.observer ?? {};
    this.onRevoked = options.onRevoked;
    this.consumer = new TspConsumer({
      recipientVid: this.vid,
      decryptionKey: this.identity.decryptionKey,
      signingKey: this.identity.signingKey,
      allowedSenders: new Set([this.provider.vid]),
      resolveSender: () => ({ encryptionKey: this.provider.encryptionKey, signingKey: this.provider.signingKey }),
      proofVerifier: this.verifier,
      payloadValidator: schemaValidator,
      now: () => this.clock.now(),
      newErrorId: () => this.newId(),
    });
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  /** The provider's `hcp/*` Type URIs (trust-task-discovery 0.4). */
  async discover(): Promise<string[]> {
    const reply = await this.exchange(this.build(discovery.TYPE_URI, { patterns: ["hcp/*"] }));
    if (reply.type !== discovery.RESPONSE_TYPE_URI) throw new Error(`discovery answered ${reply.type}`);
    return (reply.payload as discovery.Response).supportedTypes as string[];
  }

  // ── Grants (B2) ────────────────────────────────────────────────────────────

  /**
   * Ask for a grant and wait through the hold: each next step is followed, no
   * sooner than its `retryAfter`, by a resubmission (a new document, fresh
   * `id`, same `threadId` and payload). Ends with the grant, a refusal, or
   * `held` once `maxHoldSeconds` has passed.
   */
  async requestGrant(ask: GrantAsk, options: RequestGrantOptions = {}): Promise<GrantOutcome> {
    const threadId = this.newId();
    this.threads.set(threadId, { ask });
    await options.onPairing?.(pairingFor(this.vid, threadId, options.vtaDid ?? this.provider.vid));
    const startedAt = this.clock.now();
    const limit = (options.maxHoldSeconds ?? this.maxHoldSeconds) * 1000;
    let outcome = await this.sendGrantRequest(threadId, ask, threadId);
    for (let attempt = 1; outcome.kind === "held"; attempt++) {
      const heldAt = this.clock.now();
      if (heldAt - startedAt >= limit) return outcome;
      await options.onHeld?.({ threadId, attempt, retryAfter: outcome.retryAfter });
      // Not sooner than retryAfter, counted from receipt of the next step.
      const waitMs = heldAt + outcome.retryAfter * 1000 - this.clock.now();
      if (waitMs > 0) await this.clock.sleep(waitMs / 1000);
      outcome = await this.sendGrantRequest(threadId, ask);
    }
    return outcome;
  }

  /**
   * Send one resubmission on `threadId`. After approval it returns the same
   * grant with a newly issued token, which the wallet adds; earlier tokens stay
   * valid until the grant ends. Use this, never a re-sent copy of an earlier
   * document, to recover a lost response: the client does not rely on a replay
   * record to return the earlier response.
   */
  async resubmit(threadId: string, ask?: GrantAsk): Promise<GrantOutcome> {
    const thread = this.threads.get(threadId);
    const payload = ask ?? thread?.ask;
    if (payload === undefined) throw new Error(`no grant request on thread ${threadId}`);
    return this.sendGrantRequest(threadId, payload);
  }

  private async sendGrantRequest(threadId: string, ask: GrantAsk, id?: string): Promise<GrantOutcome> {
    const reply = await this.exchange(this.build(`${grantRequest.TYPE_URI}#request`, ask, threadId, id));
    if (reply.type === nextStep.TYPE_URI) {
      const step = reply.payload as nextStep.Payload;
      const expected = step.expects.find((e) => e.typeUri === `${grantRequest.TYPE_URI}#request`);
      if (expected === undefined || step.continuation !== "resubmit") throw new Error("a next step this client cannot follow");
      return { kind: "held", threadId, retryAfter: retryAfterOf(expected.hint) };
    }
    if (reply.type === grantRequest.RESPONSE_TYPE_URI) {
      const { accessToken, tokenExpiresAt, grant } = reply.payload as grantRequest.Response;
      if (grant.client.id !== this.vid) throw new Error("the grant names another client");
      this.wallet.addToken(threadId, grant, accessToken, tokenExpiresAt);
      const view = this.wallet.view(grant.grantId)!;
      return { kind: "granted", threadId, grantId: grant.grantId, grant, tokenExpiresAt, tokenCount: view.tokenCount };
    }
    const refusal = this.refusal(reply);
    return { kind: "refused", threadId, ...refusal };
  }

  // ── Query (B3) ─────────────────────────────────────────────────────────────

  /**
   * Query the person's context under `grantId`. Entries come back in the
   * provider's order, never filtered, reordered or padded here. Each copy's
   * `useUntil` is capped at min(the response + 1 hour, the grant's
   * `expiresAt`). On `hcp:invalidToken` the client forgets the grant at once
   * (hcp/grants/revoked "Independence").
   */
  async query(grantId: string, input: QueryInput): Promise<QueryOutcome> {
    const token = this.wallet.tokenFor(grantId);
    if (token === undefined) return { kind: "no-grant", grantId };
    const payload: query.Payload = { query: input.query, purpose: input.purpose, accessToken: token };
    if (input.categories !== undefined) payload.categories = input.categories as query.Payload["categories"];
    if (input.maxEntries !== undefined) payload.maxEntries = input.maxEntries;
    const reply = await this.exchange(this.build(`${query.TYPE_URI}#request`, payload));
    if (reply.type !== query.RESPONSE_TYPE_URI) {
      const refusal = this.refusal(reply);
      const grantForgotten = refusal.code === "hcp:invalidToken" && this.wallet.forget(grantId);
      return { kind: "refused", grantId, ...refusal, grantForgotten };
    }
    const r = reply.payload as query.Response;
    const grant = this.wallet.view(grantId)?.grant;
    const cap = Math.min(Date.parse(r.respondedAt) + MAX_USE_SECONDS * 1000, grant?.expiresAt ? Date.parse(grant.expiresAt) : Infinity);
    const entries: DisclosedEntry[] = (r.entries as unknown[]).map((raw) => {
      const e = raw as { ref?: string; id?: string; content?: { value?: unknown }; classification?: { categories?: string[] }; useUntil?: string };
      const useUntil = e.useUntil === undefined ? cap : Math.min(Date.parse(e.useUntil), cap);
      const entry: DisclosedEntry = { ref: e.ref ?? e.id ?? "", categories: e.classification?.categories ?? [], useUntil: iso(Math.floor(useUntil / 1000) * 1000) };
      if (typeof e.content?.value === "string") entry.text = e.content.value;
      return entry;
    });
    const copies: Copy[] = entries.map((e) => ({ ...e, purpose: input.purpose, retrievalId: r.retrievalId }));
    const directives = ((r as { directives?: unknown[] }).directives ?? []) as unknown[];
    this.wallet.addCopies(grantId, copies, directives);
    return {
      kind: "entries",
      grantId,
      purpose: input.purpose,
      retrievalId: r.retrievalId,
      entries,
      categoriesSearched: (r.categoriesSearched ?? []) as string[],
      minimization: r.minimization,
      directives,
    };
  }

  // ── Revocation notices (B4) ────────────────────────────────────────────────

  /**
   * Receive one sealed TSP message from the provider: an `hcp/grants/revoked`
   * notice. Runs the SPEC §7.2 pipeline (sender, freshness, replay, proof,
   * schema), then deduplicates on `noticeId`: a notice not seen before makes
   * the client forget the grant; a later attempt is only acknowledged. Returns
   * the sealed acknowledgement to send back, if there is one.
   */
  async receive(wire: Uint8Array): Promise<Uint8Array | undefined> {
    const unpacked = await unpackTrustTask(wire, {
      recipientVid: this.vid,
      keys: { receiverDecryptionKey: this.identity.decryptionKey, senderSigningKey: this.provider.signingKey },
    });
    if (unpacked.document.type.split("#")[0] !== revoked.TYPE_URI) throw new Error(`no handler for ${unpacked.document.type}`);
    this.observer.notice?.(unpacked.document as unknown as TrustTaskDocument<unknown>);
    const received = await this.consumer.consume(unpacked, revoked.SPEC, (doc) => this.onNotice(doc as TrustTaskDocument<revoked.Payload>));
    if (received.reply === undefined) return undefined;
    return this.consumer.packReply(received);
  }

  private onNotice(doc: TrustTaskDocument<revoked.Payload>): TrustTaskDocument<unknown> {
    const now = this.clock.now();
    if (doc.issuer !== this.provider.vid || doc.proof === undefined || proofPurposeOf(doc) !== PROOF_PURPOSE) {
      return rejectWith(doc, this.newId(), { code: "permissionDenied", message: "The request is not authorized.", retryable: false }, () => this.clock.issue()) as TrustTaskDocument<unknown>;
    }
    for (const [id, n] of this.notices) if (now - n.processedAt > NOTICE_RETENTION_SECONDS * 1000) this.notices.delete(id);
    const { noticeId, grantId, revokedAt } = doc.payload;
    if (!this.notices.has(noticeId)) {
      const record: ProcessedNotice = { noticeId, grantId, revokedAt, processedAt: now, notice: doc };
      this.notices.set(noticeId, record);
      this.wallet.forget(grantId);
      this.onRevoked?.(record);
    }
    return this.sign(respondWith(doc, this.newId(), {}, () => this.clock.issue()));
  }

  // ── State ──────────────────────────────────────────────────────────────────

  /** The grants the client holds, without tokens. */
  grants(): GrantView[] {
    return this.wallet.list();
  }

  grant(grantId: string): GrantView | undefined {
    return this.wallet.view(grantId);
  }

  /** The notices processed and still remembered. */
  processedNotices(): ProcessedNotice[] {
    return [...this.notices.values()];
  }

  /** Stop using a grant: drop its tokens and copies. */
  forgetGrant(grantId: string): boolean {
    return this.wallet.forget(grantId);
  }

  /** Drop copies whose `useUntil` has passed. */
  purgeExpired(): number {
    return this.wallet.purgeExpired(this.clock.now());
  }

  /**
   * Whether `text` contains any token the client holds. The tool layer checks
   * every result with it before a model sees the result.
   */
  containsToken(text: string): boolean {
    return this.wallet.allTokens().some((t) => text.includes(t));
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  /** Build and sign a request to the provider. A resubmission passes the first document's `threadId`. */
  private build<P>(type: string, payload: P, threadId?: string, id?: string): TrustTaskDocument<P> {
    const docId = id ?? this.newId();
    const doc: TrustTaskDocument<P> = {
      id: docId,
      type,
      issuer: this.vid,
      recipient: this.provider.vid,
      issuedAt: this.clock.issue(),
      threadId: threadId ?? docId,
      payload,
    };
    return this.sign(doc);
  }

  private sign<P>(doc: TrustTaskDocument<P>): TrustTaskDocument<P> {
    return signTrustTask(doc, this.identity.signer, { proofPurpose: PROOF_PURPOSE, created: new Date(Date.parse(doc.issuedAt!)) });
  }

  /** Seal `doc` to the provider, carry it, open the reply and check it before use. */
  private async exchange(doc: TrustTaskDocument<unknown>): Promise<TrustTaskDocument<any>> {
    this.observer.sent?.(doc);
    const wire = await packTrustTask(doc as unknown as Record<string, unknown>, {
      senderVid: this.vid,
      receiverVid: this.provider.vid,
      keys: { senderSigningKey: this.identity.signingKey, receiverEncryptionKey: this.provider.encryptionKey },
    });
    const replyWire = await this.carrier(wire);
    const opened = await unpackTrustTask(replyWire, {
      recipientVid: this.vid,
      keys: { receiverDecryptionKey: this.identity.decryptionKey, senderSigningKey: this.provider.signingKey },
    });
    const reply = opened.document as unknown as TrustTaskDocument<any>;
    await this.checkReply(reply, doc.threadId ?? doc.id);
    this.observer.received?.(reply);
    return reply;
  }

  /**
   * The checks on a reply before it is used: from the provider, on the thread,
   * signed unless the library pipeline built it, the proof an authentication
   * proof that verifies, and the payload valid against its schema.
   */
  async checkReply(reply: TrustTaskDocument<any>, threadId: string): Promise<void> {
    if (reply.issuer !== this.provider.vid) throw new Error(`reply issuer ${reply.issuer} is not the provider`);
    if (reply.threadId !== threadId) throw new Error(`reply threadId ${reply.threadId} is not ${threadId}`);
    const libraryError = reply.type === error.TYPE_URI && PIPELINE_CODES.has(reply.payload?.code);
    if (reply.proof === undefined) {
      if (!libraryError) throw new Error(`reply ${reply.type} carries no proof`);
    } else {
      if (proofPurposeOf(reply) !== PROOF_PURPOSE) throw new Error(`reply proof purpose is not ${PROOF_PURPOSE}`);
      if (!(await this.verifier.verify(reply))) throw new Error("reply proof does not verify");
    }
    validateReply(reply);
  }

  private refusal(reply: TrustTaskDocument<any>): { code: string; message: string } {
    if (reply.type !== error.TYPE_URI) throw new Error(`unexpected reply ${reply.type}`);
    const p = reply.payload as error.Payload;
    return { code: p.code, message: p.message ?? "" };
  }
}

function proofPurposeOf(doc: TrustTaskDocument<unknown>): string | undefined {
  const proof = doc.proof as { proofPurpose?: string } | { proofPurpose?: string }[] | undefined;
  return Array.isArray(proof) ? proof[0]?.proofPurpose : proof?.proofPurpose;
}
