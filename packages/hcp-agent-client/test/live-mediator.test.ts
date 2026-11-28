// Live runs through a real mediator. Skipped unless HCP_LIVE_MEDIATOR_DID
// names one. Two parties log in to it over WebSocket with connectMediatorLink:
// the agent client, and the vendored reference provider (test/reference/)
// behind a second mediator identity. Every message is a sealed TSP 1.0
// message, and every one crosses the mediator: the relationship invite and
// accept, the held grant request and its resubmission, the query, a pushed
// revocation notice and its acknowledgement.
//
//   HCP_LIVE_MEDIATOR_DID=did:peer:2...  [HCP_LIVE_MEDIATOR_INSECURE=1]  [HCP_LIVE_REPORT=out.json] \
//     npx tsx --test test/live-mediator.test.ts
//
// HCP_LIVE_MEDIATOR_INSECURE=1 allows an http:// and ws:// mediator (a local
// test mediator only). The report records how each frame reached each party:
// sealed by the peer and passed on as it was, or wrapped by the mediator.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { packTrustTask, unpackTrustTask } from "@openvtc/trust-tasks-tsp";
import { decodeEnvelope, packAccept, unpack } from "@openvtc/vti-tsp-js";

import {
  HcpAgentClient,
  MediatorCarrier,
  connectMediatorLink,
  identityFromKeys,
  publicKeysOf,
  type AgentIdentity,
  type MediatorConnectionLink,
  type MediatorLink,
  type PeerKeys,
} from "../src/index.js";
import { HcpGrantsRevoked_v0_1 } from "../src/trust-tasks/index.js";
import { ASK, QUERY, World, referenceCarrier, stepRevoke } from "./harness.js";

const MEDIATOR_DID = process.env.HCP_LIVE_MEDIATOR_DID;
const INSECURE = process.env.HCP_LIVE_MEDIATOR_INSECURE === "1";
const SKIP = MEDIATOR_DID ? false : "set HCP_LIVE_MEDIATOR_DID to run against a live mediator";

interface FrameRecord {
  to: "agent" | "provider";
  /** How it arrived: sealed by the peer and passed on as it was, or a message from the mediator. */
  form: "as sent by the peer" | "wrapped by the mediator" | string;
  bytes: number;
  /** What was inside, once unwrapped (provider side). */
  content?: string;
}

type RecordingLink = MediatorLink & { last?: FrameRecord };

/** Both parties logged in, the reference provider answering behind its login, and a client ready to talk to it. */
async function live(name: string) {
  const world = new World();
  const { provider: P, contextClient: C } = world;
  const agentIdentity = identityFromKeys(C.sigPriv, C.encPriv); // DEMO ONLY keys: the reference Context Client's
  const providerIdentity = identityFromKeys(P.sigPriv, P.encPriv); // DEMO ONLY keys: the reference provider's
  const providerKeys: PeerKeys = { vid: P.vid, signingKey: P.sigPub, encryptionKey: P.encPub };
  const frames: FrameRecord[] = [];
  const steps: string[] = [];
  const drops: string[] = [];
  const acks: { type: string; threadId?: string }[] = [];
  const revoked: string[] = [];
  const say = (line: string) => {
    steps.push(line);
    console.log(`[live] ${line}`);
  };
  const connect = (identity: AgentIdentity, peerDid: string) =>
    connectMediatorLink({ identity, mediatorDid: MEDIATOR_DID!, providerDid: peerDid, ...(INSECURE ? { allowInsecure: true } : {}) });
  const recording = (link: MediatorLink, to: FrameRecord["to"], peerVid: string, mediatorVid: string): RecordingLink => {
    const r: RecordingLink = {
      send: (f) => link.send(f),
      receive: async (t) => {
        const f = await link.receive(t);
        if (f !== undefined) {
          const { sender } = decodeEnvelope(f).envelope;
          r.last = { to, form: sender === peerVid ? "as sent by the peer" : sender === mediatorVid ? "wrapped by the mediator" : `from ${sender}`, bytes: f.length };
          frames.push(r.last);
        }
        return f;
      },
    };
    return r;
  };

  const links: MediatorConnectionLink[] = [];
  const provider = await connect(providerIdentity, C.vid);
  links.push(provider);
  say(`provider ${P.vid} logged in to the mediator`);
  const mediatorVid = provider.mediator.vid;

  // ── The provider's side: the reference provider behind its own mediator login. ──
  const providerLink = recording(provider.link, "provider", C.vid, mediatorVid);
  const providerSide = new MediatorCarrier({ identity: providerIdentity, mediator: provider.mediator, provider: publicKeysOf(agentIdentity), link: providerLink });
  const reference = referenceCarrier(world);
  const stopProvider = new AbortController();
  const pump = (async () => {
    while (!stopProvider.signal.aborted) {
      const frame = await providerLink.receive(250);
      if (frame === undefined) continue;
      const record = providerLink.last!;
      const direct = await providerSide.unwrap(frame);
      const opened = await unpack(direct, { receiverDecryptionKey: P.encPriv, senderSigningKey: C.sigPub });
      if (opened.control !== undefined) {
        record.content = `control ${opened.control.controlType}`;
        if (opened.control.controlType === "invite") {
          const accept = await packAccept(opened.threadDigest, P.vid, C.vid, { senderSigningKey: P.sigPriv, receiverEncryptionKey: C.encPub });
          await providerLink.send(await providerSide.wrap(accept.bytes));
        }
        continue;
      }
      const { document } = await unpackTrustTask(direct, { recipientVid: P.vid, keys: { receiverDecryptionKey: P.encPriv, senderSigningKey: C.sigPub } });
      record.content = document.type;
      if (document.type.endsWith("#response")) {
        acks.push({ type: document.type, threadId: document.threadId as string | undefined });
        continue;
      }
      await providerLink.send(await providerSide.wrap(await reference(direct)));
    }
  })();
  pump.catch(() => {});

  // ── The agent's side. ──
  const connectAgent = async () => {
    const agent = await connect(agentIdentity, P.vid);
    links.push(agent);
    const mc = new MediatorCarrier({
      identity: agentIdentity,
      mediator: agent.mediator,
      provider: providerKeys,
      link: recording(agent.link, "agent", P.vid, mediatorVid),
      replyTimeoutMs: 20_000,
      pollTimeoutMs: 1_000,
      onDrop: (r) => drops.push(r),
    });
    return { agent, mc };
  };
  const first = await connectAgent();
  say(`agent ${C.vid} logged in to the mediator`);
  const client = new HcpAgentClient({
    identity: agentIdentity,
    provider: providerKeys,
    carrier: first.mc.carrier,
    clock: { now: world.clock.now, issue: world.clock.tick, sleep: async (s) => world.clock.advance(s) },
    newId: world.ids.next,
    onRevoked: (n) => revoked.push(n.grantId),
  });

  /** Relate, ask for a grant (approved on the first hold), and query under it. */
  const grantAndQuery = async (mc: MediatorCarrier) => {
    await mc.relate();
    say("relationship: invite and accept crossed the mediator");
    const outcome = await client.requestGrant(ASK, {
      onHeld: ({ threadId, attempt }) => {
        say(`grant request held (attempt ${attempt})`);
        if (attempt === 1) world.personApproves(threadId);
      },
    });
    assert.equal(outcome.kind, "granted");
    if (outcome.kind !== "granted") throw new Error("no grant");
    say(`granted ${outcome.grantId} after the hold`);
    const q = await client.query(outcome.grantId, QUERY);
    assert.equal(q.kind, "entries");
    if (q.kind === "entries") say(`query answered: ${q.entries.length} entries`);
    return outcome.grantId;
  };

  /** The person revokes; the provider pushes the notice through the mediator. Returns the notice's thread. */
  const pushNotice = async (grantId: string) => {
    await stepRevoke(world, grantId);
    const grant = world.grants.find((g) => g.grantId === grantId)!;
    const notice = world.request(P, C, `${HcpGrantsRevoked_v0_1.TYPE_URI}#request`, { grantId, noticeId: world.ids.next(), revokedAt: grant.revokedAt! });
    const sealed = await packTrustTask(notice as never, { senderVid: P.vid, receiverVid: C.vid, keys: { senderSigningKey: P.sigPriv, receiverEncryptionKey: C.encPub } });
    await providerLink.send(await providerSide.wrap(sealed));
    return notice.threadId as string;
  };

  /** Run the agent's receive loop until the provider has the acknowledgement (bounded). */
  const receiveUntilAcked = async (mc: MediatorCarrier) => {
    const stop = new AbortController();
    const watch = setInterval(() => acks.length > 0 && stop.abort(), 100);
    try {
      const loop = await mc.run({ onInbound: (m) => client.receive(m), signal: stop.signal, runForMs: 20_000 });
      say(`receive loop stopped (${loop.stopped}): ${loop.delivered} delivered, ${loop.dropped} dropped`);
    } finally {
      clearInterval(watch);
    }
  };

  const close = async () => {
    stopProvider.abort();
    await pump.catch(() => {});
    console.log(`[live] frames: ${JSON.stringify(frames)}`);
    if (drops.length > 0) console.log(`[live] dropped: ${JSON.stringify(drops)}`);
    if (process.env.HCP_LIVE_REPORT) writeFileSync(`${process.env.HCP_LIVE_REPORT}.${name}.json`, `${JSON.stringify({ mediatorDid: MEDIATOR_DID, agent: C.vid, provider: P.vid, steps, frames, drops }, null, 2)}\n`);
    for (const l of links) l.close();
  };

  return { client, first, connectAgent, grantAndQuery, pushNotice, receiveUntilAcked, close, say, acks, revoked, frames };
}

test(
  "live: the agent client and the reference provider exchange sealed TSP 1.0 messages through a real mediator",
  { skip: SKIP, timeout: 180_000 },
  async () => {
    const l = await live("online");
    try {
      const grantId = await l.grantAndQuery(l.first.mc);
      const thread = await l.pushNotice(grantId);
      await l.receiveUntilAcked(l.first.mc);
      assert.deepEqual(l.revoked, [grantId], "the notice reached the client through the mediator");
      assert.equal(l.acks.length, 1, "the acknowledgement reached the provider through the mediator");
      assert.equal(l.acks[0]!.threadId, thread);
      assert.equal(await l.client.query(grantId, QUERY).then((r) => r.kind), "no-grant");
      l.say("revocation notice delivered and acknowledged; the grant is gone");
      assert.ok(l.frames.some((f) => f.to === "agent") && l.frames.some((f) => f.to === "provider"));
    } finally {
      await l.close();
    }
  },
);

test(
  "live: a notice pushed while the agent is offline reaches it when it logs in again",
  { skip: SKIP, timeout: 180_000 },
  async () => {
    const l = await live("offline");
    try {
      const grantId = await l.grantAndQuery(l.first.mc);
      l.first.agent.close();
      l.say("agent logged out");
      const thread = await l.pushNotice(grantId);
      l.say("provider pushed the notice while the agent was offline");
      const again = await l.connectAgent();
      l.say("agent logged in again");
      await l.receiveUntilAcked(again.mc);
      assert.deepEqual(l.revoked, [grantId], "the mediator held the notice and delivered it on the next login");
      assert.equal(l.acks.length, 1);
      assert.equal(l.acks[0]!.threadId, thread);
    } finally {
      await l.close();
    }
  },
);
