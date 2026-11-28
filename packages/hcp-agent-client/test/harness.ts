// Puts the client in front of the reference provider: the provider, the
// Management Client and the shared clock and identifiers of the vendored
// `examples/hcp-demo-ts` World (test/reference/, pinned in SOURCE.json), with
// this package's HcpAgentClient in the Context Client's place.
//
// The client seals each request itself; the carrier hands the sealed bytes to
// the provider's own TSP consumer and handler, and hands back the sealed reply.
// The World's provider is used as it is; only its private consumer map and
// handler are reached, so the vendored files stay byte for byte as upstream.

import type { SpecPolicy, TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import { DataIntegrityProofVerifier } from "@openvtc/trust-tasks-proof";
import { advertisedSender, packTrustTask, unpackTrustTask, type TspConsumer } from "@openvtc/trust-tasks-tsp";
import * as discovery from "@openvtc/trust-tasks/trust-task-discovery/0.4/payload";

import { HcpAgentClient, identityFromKeys, type Carrier, type HcpAgentClientOptions } from "../src/index.js";
import { HcpEntriesQuery_v0_1, HcpGrantsRequest_v0_1, HcpGrantsRevoke_v0_1, HcpGrantsRevoked_v0_1 } from "../src/trust-tasks/index.js";
import { World, pretty, redact, type Party } from "./reference/demo.js";

export { ASK, HOLD_LIFETIME, MANAGEMENT_TOKEN, PURPOSE, World, stepRevoke, tokenDigest } from "./reference/demo.js";

const SPECS: Record<string, SpecPolicy> = {
  [discovery.TYPE_URI]: discovery.SPEC,
  [HcpGrantsRequest_v0_1.TYPE_URI]: HcpGrantsRequest_v0_1.SPEC,
  [HcpEntriesQuery_v0_1.TYPE_URI]: HcpEntriesQuery_v0_1.SPEC,
  [HcpGrantsRevoke_v0_1.TYPE_URI]: HcpGrantsRevoke_v0_1.SPEC,
  [HcpGrantsRevoked_v0_1.TYPE_URI]: HcpGrantsRevoked_v0_1.SPEC,
};

/** The World's private parts the harness reaches. */
interface WorldInternals {
  consumers: Map<string, TspConsumer>;
  handle(me: Party, doc: TrustTaskDocument<unknown>): unknown;
}

export interface Harness {
  world: World;
  client: HcpAgentClient;
  /** Every document the client sent, in order. */
  sent: TrustTaskDocument<any>[];
  /** Push a revocation notice for `grantId` from the provider, as the next delivery attempt of `previous` when given. */
  sendNotice(grantId: string, previous?: TrustTaskDocument<any>): Promise<{ notice: TrustTaskDocument<any>; ack: TrustTaskDocument<any> | undefined }>;
}

export const QUERY = { query: "How does Alex like to fly?", categories: ["travel_preferences"], purpose: "https://purposes.example/travel-booking", maxEntries: 5 };

/** The reference provider as a carrier: opens a sealed request, runs the provider's consumer and handler, seals the reply. */
export function referenceCarrier(world: World): Carrier {
  const internals = world as unknown as WorldInternals;
  const P = world.provider;
  return async (wire) => {
    const sender = world.byVid(advertisedSender(wire)!);
    const unpacked = await unpackTrustTask(wire, { recipientVid: P.vid, keys: { receiverDecryptionKey: P.encPriv, senderSigningKey: sender.sigPub } });
    const spec = SPECS[unpacked.document.type.split("#")[0]!];
    if (spec === undefined) throw new Error(`the reference provider has no handler for ${unpacked.document.type}`);
    const consumer = internals.consumers.get(P.vid)!;
    const received = await consumer.consume(unpacked, spec, (doc) => internals.handle(P, doc) as never);
    if (received.reply === undefined) throw new Error(`no reply: ${received.outcome.kind}`);
    return consumer.packReply(received);
  };
}

export function harness(options: Partial<HcpAgentClientOptions> = {}, world = new World()): Harness {
  const { provider: P, contextClient: C } = world;
  const print = (from: string, to: string, doc: TrustTaskDocument<unknown>) =>
    world.transcript.push(`--> ${from} -> ${to} (TSP) ${doc.type}\n${pretty(redact(doc))}\n`);
  const sent: TrustTaskDocument<any>[] = [];

  const carrier = referenceCarrier(world);

  const client = new HcpAgentClient({
    identity: identityFromKeys(C.sigPriv, C.encPriv), // DEMO ONLY keys: the registered Context Client's
    provider: { vid: P.vid, signingKey: P.sigPub, encryptionKey: P.encPub },
    carrier,
    clock: { now: world.clock.now, issue: world.clock.tick, sleep: async (s) => world.clock.advance(s) },
    newId: world.ids.next,
    observer: {
      sent: (d) => {
        sent.push(d);
        print("Context Client", "Provider", d);
      },
      received: (d) => print("Provider", "Context Client", d),
    },
    ...options,
  });

  const verifier = new DataIntegrityProofVerifier({ now: world.clock.now });
  const sendNotice: Harness["sendNotice"] = async (grantId, previous) => {
    const grant = world.grants.find((g) => g.grantId === grantId)!;
    const payload = previous?.payload ?? { grantId, noticeId: world.ids.next(), revokedAt: grant.revokedAt! };
    const notice = world.request(P, C, `${HcpGrantsRevoked_v0_1.TYPE_URI}#request`, payload, previous?.threadId);
    print("Provider", "Context Client", notice);
    const wire = await packTrustTask(notice as unknown as Record<string, unknown>, {
      senderVid: P.vid,
      receiverVid: C.vid,
      keys: { senderSigningKey: P.sigPriv, receiverEncryptionKey: C.encPub },
    });
    const replyWire = await client.receive(wire);
    if (replyWire === undefined) return { notice, ack: undefined };
    const opened = await unpackTrustTask(replyWire, { recipientVid: P.vid, keys: { receiverDecryptionKey: P.encPriv, senderSigningKey: C.sigPub } });
    const ack = opened.document as unknown as TrustTaskDocument<any>;
    if (ack.issuer !== C.vid || ack.threadId !== notice.threadId) throw new Error("the acknowledgement is not the client's, on the notice's thread");
    if (ack.proof !== undefined && !(await verifier.verify(ack))) throw new Error("the acknowledgement's proof does not verify");
    print("Context Client", "Provider", ack);
    return { notice, ack };
  };

  return { world, client, sent, sendNotice };
}
