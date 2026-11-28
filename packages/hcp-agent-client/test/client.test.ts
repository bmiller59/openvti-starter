// The client's behaviour against the reference provider: grant and hold,
// resubmission with a new token, query, revocation and purge, a duplicate
// notice, and the checks it makes on what it receives. Hermetic and
// deterministic (fixed DEMO ONLY keys, ids and clock).

import assert from "node:assert/strict";
import { test } from "node:test";

import { signTrustTask } from "@openvtc/trust-tasks-proof";

import { DEFAULT_RETRY_AFTER, iso, pairingNumber, providerFromDidDocument, retryAfterOf, type Pairing } from "../src/index.js";
import { ASK, PURPOSE, QUERY, World, harness, stepRevoke, tokenDigest } from "./harness.js";

const ERROR = "https://trusttasks.org/spec/trust-task-error/0.6";

async function granted(h = harness()) {
  const pairings: Pairing[] = [];
  const outcome = await h.client.requestGrant(ASK, {
    onPairing: (p) => void pairings.push(p),
    onHeld: ({ threadId, attempt }) => {
      if (attempt === 1) h.world.personApproves(threadId);
    },
  });
  if (outcome.kind !== "granted") throw new Error(`expected a grant, got ${outcome.kind}`);
  return { ...h, outcome, pairing: pairings[0]! };
}

test("grant: the request is held, the client waits retryAfter, resubmits on the thread and gets the grant", async () => {
  const { client, sent, outcome, world } = await granted();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.threadId, sent[0]!.id, "the resubmission keeps the first document's threadId");
  assert.notEqual(sent[1]!.id, sent[0]!.id, "the resubmission is a new document");
  assert.equal(Date.parse(sent[1]!.issuedAt!) - Date.parse(sent[0]!.issuedAt!), 3000, "1 s for the reply, 1 s of retryAfter, 1 s to issue");
  assert.equal(outcome.tokenExpiresAt, outcome.grant.expiresAt);
  assert.equal(outcome.tokenCount, 1);
  assert.equal(world.grants.length, 1);
  assert.ok(!JSON.stringify(outcome).includes("hcp_at_"), "the outcome never carries the token");
  assert.ok(!JSON.stringify(client.grants()).includes("hcp_at_"), "nor does the grant view");
});

test("grant: every hcp/* document the client signs has an authentication proof", async () => {
  const { sent } = await granted();
  for (const doc of sent) assert.equal((doc.proof as { proofPurpose: string }).proofPurpose, "authentication");
});

test("pairing: the QR carries the VID, threadId and VTA DID, and the number is four digits from them", async () => {
  const { pairing, sent, client } = await granted();
  assert.deepEqual(JSON.parse(pairing.qr), { vid: client.vid, threadId: sent[0]!.threadId, vtaDid: sent[0]!.recipient });
  assert.match(pairing.number, /^\d{4}$/);
  assert.equal(pairing.number, pairingNumber(pairing.threadId, pairing.vid));
  // A fixed vector, so another implementation can check its derivation.
  assert.equal(pairingNumber("urn:uuid:00000000-0000-4000-8000-000000000003", "did:example:agent"), "3092");
  assert.notEqual(pairingNumber("urn:uuid:a", "did:example:agent"), pairingNumber("urn:uuid:b", "did:example:agent"));
});

test("resubmit after the grant: a new token under the same grant, and both tokens stay valid", async () => {
  const { client, world, outcome } = await granted();
  const again = await client.resubmit(outcome.threadId);
  assert.equal(again.kind, "granted");
  if (again.kind !== "granted") return;
  assert.equal(again.grantId, outcome.grantId, "never a second grant");
  assert.equal(again.tokenCount, 2);
  assert.equal(world.grants.length, 1);
  assert.deepEqual(world.grants[0]!.tokenDigests, new Set([tokenDigest("hcp_at_demo_0001"), tokenDigest("hcp_at_demo_0002")]));
  // The client presents the newest token; the provider still accepts the earlier one too.
  const q = await client.query(outcome.grantId, QUERY);
  assert.equal(q.kind, "entries");
  assert.ok(world.grants[0]!.tokenDigests.has(tokenDigest("hcp_at_demo_0001")));
});

test("resubmit never re-sends an earlier document: each attempt is a fresh document", async () => {
  const { client, sent, outcome } = await granted();
  await client.resubmit(outcome.threadId);
  await client.resubmit(outcome.threadId);
  const ids = sent.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("query: entries in the provider's order, not padded to maxEntries, with purpose and a capped useUntil", async () => {
  const { client, outcome } = await granted();
  const q = await client.query(outcome.grantId, { ...QUERY, maxEntries: 5 });
  assert.equal(q.kind, "entries");
  if (q.kind !== "entries") return;
  assert.deepEqual(
    q.entries.map((e) => e.ref),
    ["hcp-ref-0001", "hcp-ref-0002"],
  );
  assert.equal(q.purpose, PURPOSE);
  assert.deepEqual(q.directives, []);
  const view = client.grant(outcome.grantId)!;
  assert.equal(view.copies.length, 2);
  for (const e of q.entries) assert.ok(Date.parse(e.useUntil) <= Date.parse(outcome.grant.expiresAt!));
});

test("query: a copy's useUntil is capped at the grant's expiresAt when the grant ends within the hour", async () => {
  const h = harness();
  const out = await h.client.requestGrant({ ...ASK, expiresIn: 1800 }, { onHeld: ({ threadId }) => h.world.personApproves(threadId) });
  assert.equal(out.kind, "granted");
  if (out.kind !== "granted") return;
  const q = await h.client.query(out.grantId, QUERY);
  if (q.kind !== "entries") throw new Error(q.kind);
  // The reference provider writes now + 1 h; the agreed rule is min(issued + 1 h, grant expiresAt).
  for (const e of q.entries) assert.equal(e.useUntil, out.grant.expiresAt);
});

test("copies are dropped once their useUntil passes", async () => {
  const { client, outcome, world } = await granted();
  await client.query(outcome.grantId, QUERY);
  world.clock.advance(3601);
  assert.equal(client.purgeExpired(), 2);
  assert.equal(client.grant(outcome.grantId)!.copies.length, 0);
});

test("revocation: the notice purges the grant, is acknowledged with {}, and the client stops", async () => {
  const revokedSeen: string[] = [];
  const h = harness({ onRevoked: (n) => void revokedSeen.push(n.grantId) });
  const { client, outcome, world, sendNotice, sent } = await granted(h);
  await client.query(outcome.grantId, QUERY);
  await stepRevoke(world, outcome.grantId);
  const { ack } = await sendNotice(outcome.grantId);
  assert.equal(ack!.type, "https://trusttasks.org/spec/hcp/grants/revoked/0.1#response");
  assert.deepEqual(ack!.payload, {});
  assert.equal((ack!.proof as { proofPurpose: string }).proofPurpose, "authentication");
  assert.equal(client.grant(outcome.grantId), undefined, "token and copies dropped");
  assert.deepEqual(revokedSeen, [outcome.grantId]);
  const before = sent.length;
  assert.equal((await client.query(outcome.grantId, QUERY)).kind, "no-grant");
  assert.equal(sent.length, before, "nothing is sent under a forgotten grant");
});

test("a duplicate notice (a later delivery attempt, same noticeId) is acknowledged and not acted on again", async () => {
  const revokedSeen: string[] = [];
  const h = harness({ onRevoked: (n) => void revokedSeen.push(n.noticeId) });
  const { client, outcome, world, sendNotice } = await granted(h);
  await stepRevoke(world, outcome.grantId);
  const first = await sendNotice(outcome.grantId);
  const second = await sendNotice(outcome.grantId, first.notice);
  assert.notEqual(second.notice.id, first.notice.id, "a new document");
  assert.equal(second.notice.payload.noticeId, first.notice.payload.noticeId, "the same notice");
  assert.deepEqual(second.ack!.payload, {});
  assert.equal(client.processedNotices().length, 1);
  assert.deepEqual(revokedSeen, [first.notice.payload.noticeId]);
});

test("a query after revoke, before any notice, gets hcp:invalidToken and the client forgets the grant at once", async () => {
  const { client, outcome, world } = await granted();
  await stepRevoke(world, outcome.grantId);
  const q = await client.query(outcome.grantId, QUERY);
  assert.deepEqual(q.kind === "refused" && [q.code, q.grantForgotten], ["hcp:invalidToken", true]);
  assert.equal(client.grants().length, 0);
});

test("decline and an expired hold end with permissionDenied; a hold past maxHoldSeconds returns held", async () => {
  const h = harness();
  const d = await h.client.requestGrant(ASK, { onHeld: ({ threadId }) => h.world.personDeclines(threadId) });
  assert.deepEqual(d.kind === "refused" && [d.code, d.message], ["permissionDenied", "The request is not authorized."]);
  const e = await h.client.requestGrant(ASK, { onHeld: ({ threadId }) => h.world.personDoesNotDecide(threadId) });
  assert.equal(e.kind === "refused" && e.code, "permissionDenied");
  const held = await h.client.requestGrant(ASK, { maxHoldSeconds: 30 });
  assert.equal(held.kind, "held");
  assert.equal(held.kind === "held" && held.retryAfter, 1);
});

test("reply checks: unsigned refusals, a wrong proof purpose, another issuer or thread are refused", async () => {
  const { client, world } = harness();
  const P = world.provider;
  const base = { id: world.ids.next(), type: ERROR, issuer: P.vid, recipient: client.vid, issuedAt: iso(world.clock.now()), threadId: "urn:uuid:00000000-0000-4000-8000-0000000000ff" };
  const denied = { ...base, payload: { code: "permissionDenied", message: "The request is not authorized.", retryable: false } };
  const pipeline = { ...base, payload: { code: "proofInvalid", message: "bad proof", retryable: false } };
  const sign = (doc: object, proofPurpose = "authentication", signer = P.signer) => signTrustTask(doc as never, signer, { proofPurpose, created: new Date(world.clock.now()) });
  await client.checkReply(pipeline as never, base.threadId); // the library's own unsigned refusal
  await client.checkReply(sign(denied), base.threadId);
  await assert.rejects(client.checkReply(denied as never, base.threadId), /no proof/);
  await assert.rejects(client.checkReply(sign(denied, "assertionMethod"), base.threadId), /proof purpose/);
  await assert.rejects(client.checkReply(sign({ ...denied, issuer: world.management.vid }, "authentication", world.management.signer), base.threadId), /issuer/);
  await assert.rejects(client.checkReply(sign(denied), "urn:uuid:00000000-0000-4000-8000-0000000000fe"), /threadId/);
});

test("a notice signed for another proof purpose is refused and the grant is kept", async () => {
  const { client, outcome, world } = await granted();
  await stepRevoke(world, outcome.grantId);
  const P = world.provider;
  const { packTrustTask } = await import("@openvtc/trust-tasks-tsp");
  const notice = signTrustTask(
    {
      id: world.ids.next(),
      type: "https://trusttasks.org/spec/hcp/grants/revoked/0.1#request",
      issuer: P.vid,
      recipient: client.vid,
      issuedAt: world.clock.tick(),
      payload: { grantId: outcome.grantId, noticeId: world.ids.next(), revokedAt: world.grants[0]!.revokedAt! },
    } as never,
    P.signer,
    { proofPurpose: "assertionMethod", created: new Date(world.clock.now()) },
  );
  const wire = await packTrustTask(notice as never, { senderVid: P.vid, receiverVid: client.vid, keys: { senderSigningKey: P.sigPriv, receiverEncryptionKey: world.contextClient.encPub } });
  await client.receive(wire);
  assert.ok(client.grant(outcome.grantId), "not acted on");
  assert.equal(client.processedNotices().length, 0);
});

test("the next step's hint: a valid retryAfter is used, anything else means the default", () => {
  assert.equal(retryAfterOf({ retryAfter: 1 }), 1);
  assert.equal(retryAfterOf({ retryAfter: 3600 }), 3600);
  for (const bad of [undefined, { retryAfter: 2.5 }, { retryAfter: 0 }, { retryAfter: "5" }, { retryAfter: 3601 }, { retryAfter: 1, extra: true }, {}, null, 5]) {
    assert.equal(retryAfterOf(bad), DEFAULT_RETRY_AFTER);
  }
});

test("provider seam: keys and the TSP route come from the VTA's DID document, wherever it is hosted", () => {
  const world = new World();
  const P = world.provider;
  const mb = (codec: number[], key: Uint8Array) => `z${base58(new Uint8Array([...codec, ...key]))}`;
  const doc = {
    id: "did:example:vta",
    verificationMethod: [
      { id: "did:example:vta#key-1", type: "Multikey", publicKeyMultibase: mb([0xed, 0x01], P.sigPub) },
      { id: "did:example:vta#key-2", type: "Multikey", publicKeyMultibase: mb([0xec, 0x01], P.encPub) },
    ],
    authentication: ["#key-1"],
    keyAgreement: ["did:example:vta#key-2"],
    service: [{ id: "#tsp", type: "TSPTransport", serviceEndpoint: "did:example:mediator" }],
  };
  const endpoint = providerFromDidDocument(doc);
  assert.deepEqual(endpoint.keys.signingKey, P.sigPub);
  assert.deepEqual(endpoint.keys.encryptionKey, P.encPub);
  assert.equal(endpoint.tspEndpoint, "did:example:mediator");
  assert.throws(() => providerFromDidDocument({ ...doc, keyAgreement: [] }), /keyAgreement/);
});

function base58(bytes: Uint8Array): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}
