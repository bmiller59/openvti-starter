// The mediator carrier and the receive loop, against a fake mediator link in
// front of the reference provider (fake-mediator.ts). No live mediator, no
// network; the time is the reference World's clock.

import assert from "node:assert/strict";
import { test } from "node:test";

import { signerFromPrivateKey } from "@openvtc/trust-tasks-proof";
import { packTrustTask } from "@openvtc/trust-tasks-tsp";
import { pack, packNested, packRouted, unpack } from "@openvtc/vti-tsp-js";

import { MediatorCarrier, identityFromKeys, type Clock } from "../src/index.js";
import { HcpGrantsRevoked_v0_1 } from "../src/trust-tasks/index.js";
import { FakeMediator, MEDIATOR, M_ENC, M_SIG, type Mode } from "./fake-mediator.js";
import { ASK, QUERY, World, harness, referenceCarrier, stepRevoke } from "./harness.js";

function setup(mode: Mode = "nested", options: { replyTimeoutMs?: number; pollTimeoutMs?: number } = {}) {
  const world = new World();
  const { provider: P, contextClient: C } = world;
  const link = new FakeMediator(world, referenceCarrier(world), mode);
  const sleeps: number[] = [];
  const clock: Clock = {
    now: world.clock.now,
    issue: world.clock.tick,
    sleep: async (s) => {
      sleeps.push(s * 1000);
      world.clock.advance(s);
    },
  };
  const drops: string[] = [];
  const mc = new MediatorCarrier({
    identity: identityFromKeys(C.sigPriv, C.encPriv), // DEMO ONLY keys: the registered Context Client's
    mediator: MEDIATOR,
    provider: { vid: P.vid, signingKey: P.sigPub, encryptionKey: P.encPub },
    link,
    clock,
    replyTimeoutMs: options.replyTimeoutMs ?? 10_000,
    pollTimeoutMs: options.pollTimeoutMs ?? 1_000,
    onDrop: (r) => void drops.push(r),
  });
  const h = harness({ carrier: mc.carrier, clock }, world);
  return { ...h, link, mc, sleeps, drops };
}

async function grant(s: ReturnType<typeof setup>) {
  const outcome = await s.client.requestGrant(ASK, {
    onHeld: ({ threadId, attempt }) => {
      if (attempt === 1) s.world.personApproves(threadId);
    },
  });
  if (outcome.kind !== "granted") throw new Error(`expected a grant, got ${outcome.kind}`);
  return outcome;
}

async function grantIdFor(s: ReturnType<typeof setup>): Promise<string> {
  const outcome = await grant(s);
  await stepRevoke(s.world, outcome.grantId);
  return outcome.grantId;
}

for (const mode of ["direct", "nested"] as const) {
  test(`through the mediator (${mode} delivery): relationship, grant with a hold, query in the provider's order`, async () => {
    const s = setup(mode);
    await s.mc.relate();
    const outcome = await grant(s);
    const q = await s.client.query(outcome.grantId, QUERY);
    assert.equal(q.kind, "entries");
    assert.deepEqual(s.link.forwarded, [
      "invite",
      "https://trusttasks.org/spec/hcp/grants/request/0.1#request",
      "https://trusttasks.org/spec/hcp/grants/request/0.1#request",
      "https://trusttasks.org/spec/hcp/entries/query/0.1#request",
    ]);
    assert.deepEqual(s.drops, []);
  });
}

test("wrap and unwrap: a Routed message to the mediator with the provider as the remaining hop; inbound unwrapped to the provider's message", async () => {
  const s = setup();
  const { provider: P, contextClient: C } = s.world;
  const direct = (await pack(new Uint8Array([1, 2, 3]), C.vid, P.vid, { senderSigningKey: C.sigPriv, receiverEncryptionKey: P.encPub })).bytes;
  const outer = await unpack(await s.mc.wrap(direct), { receiverDecryptionKey: M_ENC, senderSigningKey: C.sigPub });
  assert.equal(outer.receiver, MEDIATOR.vid);
  assert.deepEqual(outer.hops, [P.vid]);
  assert.deepEqual(outer.payload, direct, "the inner message travels unchanged");

  const fromProvider = (await pack(new Uint8Array([4]), P.vid, C.vid, { senderSigningKey: P.sigPriv, receiverEncryptionKey: C.encPub })).bytes;
  assert.deepEqual(await s.mc.unwrap(fromProvider), fromProvider);
  const nested = (await packNested(fromProvider, MEDIATOR.vid, C.vid, { senderSigningKey: M_SIG, receiverEncryptionKey: C.encPub })).bytes;
  assert.deepEqual(await s.mc.unwrap(nested), fromProvider);

  const stranger = signerFromPrivateKey("ed25519", new Uint8Array(32).fill(0x61));
  const fromStranger = (await pack(new Uint8Array([5]), stranger.did, C.vid, { senderSigningKey: new Uint8Array(32).fill(0x61), receiverEncryptionKey: C.encPub })).bytes;
  await assert.rejects(s.mc.unwrap(fromStranger), /neither the mediator nor the provider/);
  const strangerViaMediator = (await packNested(fromStranger, MEDIATOR.vid, C.vid, { senderSigningKey: M_SIG, receiverEncryptionKey: C.encPub })).bytes;
  await assert.rejects(s.mc.unwrap(strangerViaMediator), /not the provider/);
  const onward = (await packRouted(fromProvider, ["did:example:next"], MEDIATOR.vid, C.vid, { senderSigningKey: M_SIG, receiverEncryptionKey: C.encPub })).bytes;
  await assert.rejects(s.mc.unwrap(onward), /forward/);
});

test("receive loop: a pushed revocation notice reaches receive(), the grant is purged and the acknowledgement goes back", async () => {
  const s = setup();
  const outcome = await grant(s);
  await stepRevoke(s.world, outcome.grantId);
  await s.link.pushNotice(outcome.grantId);
  const result = await s.mc.run({ onInbound: (m) => s.client.receive(m), runForMs: 3_000 });
  assert.deepEqual(result, { stopped: "deadline", delivered: 1, dropped: 0 });
  assert.equal(s.client.grant(outcome.grantId), undefined);
  assert.equal(s.client.processedNotices().length, 1);
  assert.deepEqual(s.link.acks.map((a) => a.type), [`${HcpGrantsRevoked_v0_1.TYPE_URI}#response`]);
  assert.equal(await s.client.query(outcome.grantId, QUERY).then((q) => q.kind), "no-grant");
});

test("a notice that arrives while a request waits is kept for the loop; the request still gets its reply", async () => {
  const s = setup();
  const outcome = await grant(s);
  await stepRevoke(s.world, outcome.grantId);
  await s.link.pushNotice(outcome.grantId); // queued ahead of the discovery reply
  assert.ok((await s.client.discover()).length > 0);
  assert.ok(s.client.grant(outcome.grantId), "not acted on until the loop runs");
  const result = await s.mc.run({ onInbound: (m) => s.client.receive(m), runForMs: 1_000 });
  assert.equal(result.delivered, 1);
  assert.equal(s.client.grant(outcome.grantId), undefined);
});

test("a request with no reply fails after the reply timeout, never waiting longer", async () => {
  const s = setup("nested", { replyTimeoutMs: 5_000, pollTimeoutMs: 1_000 });
  s.link.holdReplies = true;
  await assert.rejects(s.client.discover(), /no reply on thread .* within 5000 ms/);
  assert.equal(s.link.waited, 5_000, "five bounded polls of 1 s, then it gave up");
});

test("receive loop: link failures back off (doubling, capped) and the loop recovers; too many in a row stop it", async () => {
  const s = setup();
  s.link.failReceives = 3;
  const result = await s.mc.run({ onInbound: async () => undefined, runForMs: 20_000, minBackoffMs: 500, maxBackoffMs: 1_500 });
  assert.equal(result.stopped, "deadline");
  assert.deepEqual(s.sleeps, [500, 1_000, 1_500]);

  const t = setup();
  t.link.failReceives = 100;
  await assert.rejects(t.mc.run({ onInbound: async () => undefined, maxConsecutiveFailures: 4, minBackoffMs: 100 }), /after 4 failures in a row: the mediator socket closed/);
  assert.deepEqual(t.sleeps, [100, 200, 400]);
});

test("receive loop: unreadable frames and replies nobody waits for are dropped; an aborted signal stops it", async () => {
  const s = setup();
  s.link.queue.push(new Uint8Array([0x00, 0x01, 0x02]));
  const { provider: P, contextClient: C } = s.world;
  const stray = s.world.request(P, C, "https://trusttasks.org/spec/trust-task-discovery/0.4#response", { supportedTypes: [] });
  await s.link.deliver(await packTrustTask(stray as never, { senderVid: P.vid, receiverVid: C.vid, keys: { senderSigningKey: P.sigPriv, receiverEncryptionKey: C.encPub } }));
  const result = await s.mc.run({ onInbound: async () => assert.fail("nothing to deliver"), runForMs: 3_000 });
  assert.deepEqual(result, { stopped: "deadline", delivered: 0, dropped: 2 });
  assert.equal(s.drops.length, 2);
  assert.match(s.drops[1]!, /nobody waits for/);

  // A pushed message the handler throws on is dropped; the loop goes on.
  await s.link.pushNotice(await grantIdFor(s));
  const refused = await s.mc.run({ onInbound: async () => { throw new Error("not for me"); }, runForMs: 2_000 });
  assert.deepEqual(refused, { stopped: "deadline", delivered: 0, dropped: 1 });
  assert.match(s.drops[2]!, /handler refused a pushed message: not for me/);

  const controller = new AbortController();
  controller.abort();
  assert.equal((await s.mc.run({ onInbound: async () => undefined, signal: controller.signal })).stopped, "signal");
});

test("the mediator carrier needs the request's thread, and one request per thread at a time", async () => {
  const s = setup();
  await assert.rejects(s.mc.carrier(new Uint8Array([1])), /threadId/);
  const ctx = { id: "urn:uuid:00000000-0000-4000-8000-0000000000f1", threadId: "urn:uuid:00000000-0000-4000-8000-0000000000f1" };
  const first = s.mc.carrier(new Uint8Array([1]), ctx); // not a TSP message: the fake mediator refuses it
  await assert.rejects(s.mc.carrier(new Uint8Array([1]), ctx), /already waiting/);
  await assert.rejects(first);
  // A failed send leaves nothing waiting on the thread.
  await assert.rejects(s.mc.carrier(new Uint8Array([1]), ctx), (e: Error) => !/already waiting/.test(e.message));
});
