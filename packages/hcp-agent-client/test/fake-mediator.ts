// A fake mediator in front of the reference provider, as a MediatorLink for
// the agent: it opens the agent's Routed message as a mediator would, hands
// the inner Direct message to the provider, and delivers the provider's
// messages back either as they are or wrapped in a Nested message from the
// mediator. No live mediator, no network. Shared by mediator.test.ts and
// examples/walkthrough.ts.

import assert from "node:assert/strict";

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { signerFromPrivateKey } from "@openvtc/trust-tasks-proof";
import { packTrustTask, unpackTrustTask } from "@openvtc/trust-tasks-tsp";
import { nextHop, packAccept, packNested, unpack } from "@openvtc/vti-tsp-js";

import type { Carrier, MediatorLink } from "../src/index.js";
import { HcpGrantsRevoked_v0_1 } from "../src/trust-tasks/index.js";
import type { World } from "./reference/demo.js";

// DEMO ONLY keys for the fake mediator: 32 repeated bytes.
export const M_SIG = new Uint8Array(32).fill(0x51);
export const M_ENC = new Uint8Array(32).fill(0x52);
export const MEDIATOR = { vid: signerFromPrivateKey("ed25519", M_SIG).did, signingKey: ed25519.getPublicKey(M_SIG), encryptionKey: x25519.getPublicKey(M_ENC) };

export type Mode = "direct" | "nested";

/** A mediator in front of the reference provider, as a MediatorLink for the agent. */
export class FakeMediator implements MediatorLink {
  readonly queue: Uint8Array[] = [];
  /** Types of the documents that reached the provider through the mediator. */
  readonly forwarded: string[] = [];
  /** The agent's acknowledgements of pushed notices, as the provider received them. */
  readonly acks: { type: string; threadId?: string }[] = [];
  holdReplies = false;
  failReceives = 0;
  waited = 0;

  constructor(
    private readonly world: World,
    private readonly provider: Carrier,
    private readonly mode: Mode,
  ) {}

  async send(frame: Uint8Array): Promise<void> {
    const C = this.world.contextClient;
    const P = this.world.provider;
    const outer = await unpack(frame, { receiverDecryptionKey: M_ENC, senderSigningKey: C.sigPub });
    assert.equal(outer.sender, C.vid);
    const step = nextHop(outer.hops, outer.payload);
    assert.equal(step.kind, "forward");
    if (step.kind !== "forward") return;
    assert.equal(step.next, P.vid, "routed on to the provider");
    const inner = await unpack(step.inner, { receiverDecryptionKey: P.encPriv, senderSigningKey: C.sigPub });
    if (inner.control?.controlType === "invite") {
      this.forwarded.push("invite");
      return this.deliver((await packAccept(inner.threadDigest, P.vid, C.vid, { senderSigningKey: P.sigPriv, receiverEncryptionKey: C.encPub })).bytes);
    }
    const { document } = await unpackTrustTask(step.inner, { recipientVid: P.vid, keys: { receiverDecryptionKey: P.encPriv, senderSigningKey: C.sigPub } });
    this.forwarded.push(document.type);
    if (document.type.endsWith("#response")) {
      this.acks.push({ type: document.type, threadId: document.threadId as string | undefined });
      return;
    }
    const reply = await this.provider(step.inner);
    if (!this.holdReplies) await this.deliver(reply);
  }

  async receive(timeoutMs: number): Promise<Uint8Array | undefined> {
    if (this.failReceives > 0) {
      this.failReceives--;
      throw new Error("the mediator socket closed");
    }
    const next = this.queue.shift();
    if (next !== undefined) return next;
    this.waited += timeoutMs;
    this.world.clock.advance(timeoutMs / 1000);
    return undefined;
  }

  /** Deliver a Direct message from the provider to the agent. */
  async deliver(direct: Uint8Array): Promise<void> {
    const C = this.world.contextClient;
    this.queue.push(this.mode === "direct" ? direct : (await packNested(direct, MEDIATOR.vid, C.vid, { senderSigningKey: M_SIG, receiverEncryptionKey: C.encPub })).bytes);
  }

  /** The provider pushes a revocation notice for `grantId`. */
  async pushNotice(grantId: string): Promise<void> {
    const { provider: P, contextClient: C } = this.world;
    const grant = this.world.grants.find((g) => g.grantId === grantId)!;
    const notice = this.world.request(P, C, `${HcpGrantsRevoked_v0_1.TYPE_URI}#request`, { grantId, noticeId: this.world.ids.next(), revokedAt: grant.revokedAt! });
    await this.deliver(await packTrustTask(notice as never, { senderVid: P.vid, receiverVid: C.vid, keys: { senderSigningKey: P.sigPriv, receiverEncryptionKey: C.encPub } }));
  }
}
