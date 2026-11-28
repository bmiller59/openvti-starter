// How the pieces wire together: the agent's identity, a grant asked for and
// held, a query made through the tool layer, and the receive loop that takes a
// revocation notice. It runs offline: the provider is the vendored reference
// provider (test/reference/, the shared HCP test vectors) behind a fake
// mediator (test/fake-mediator.ts), with the reference World's fixed keys and
// clock. Against a live VTA, swap the four marked lines.
//
//   npm run example -w @starter/hcp-agent-client

import { ContextTools, HcpAgentClient, MediatorCarrier, identityFromKeys, type Clock } from "../src/index.js";
import { FakeMediator, MEDIATOR } from "../test/fake-mediator.js";
import { ASK, PURPOSE, World, referenceCarrier, stepRevoke } from "../test/harness.js";

export interface WalkthroughResult {
  lines: string[];
  /** What the model saw from the tool, before and after the revocation. */
  before: string;
  after: string;
}

export async function walkthrough(log: (line: string) => void = () => undefined): Promise<WalkthroughResult> {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    log(line);
  };

  const world = new World();
  const { provider: P, contextClient: C } = world;
  const clock: Clock = { now: world.clock.now, issue: world.clock.tick, sleep: async (s) => world.clock.advance(s) };

  // 1. Identity. Live: identityFromPeer(didPeerFromSeed(seed, mediatorDid)) or your own keys.
  const identity = identityFromKeys(C.sigPriv, C.encPriv); // DEMO ONLY keys: the reference Context Client's
  // 2. The provider. Live: (await resolveProvider(vtaDid, didWebvhResolver(fetchText))).keys
  const provider = { vid: P.vid, signingKey: P.sigPub, encryptionKey: P.encPub };
  // 3. The mediator link. Live: const { link, mediator } = await connectMediatorLink({ identity, mediatorDid, providerDid: vtaDid })
  const link = new FakeMediator(world, referenceCarrier(world), "nested");
  // 4. The mediator's keys. Live: `mediator` from connectMediatorLink (the mediator's DID document).
  const mc = new MediatorCarrier({ identity, mediator: MEDIATOR, provider, link, clock, onDrop: (r) => say(`dropped: ${r}`) });

  const client = new HcpAgentClient({
    identity,
    provider,
    carrier: mc.carrier,
    clock,
    newId: world.ids.next,
    onRevoked: (n) => say(`revoked: ${n.grantId} (notice ${n.noticeId}); its token and every copy are gone`),
  });

  await mc.relate();
  say(`related with the provider ${P.vid.slice(0, 24)}... through the mediator`);

  // Ask for a grant. The person sees the pairing QR and number, then approves in their app;
  // here the reference World stands in for the person on the first hold.
  const outcome = await client.requestGrant(ASK, {
    onPairing: (p) => say(`pairing: show ${p.qr} and the number ${p.number}`),
    onHeld: ({ threadId, attempt, retryAfter }) => {
      say(`held (attempt ${attempt}), retry after ${retryAfter} s`);
      if (attempt === 1) world.personApproves(threadId);
    },
  });
  if (outcome.kind !== "granted") throw new Error(`no grant: ${outcome.kind}`);
  say(`granted: ${outcome.grantId}`);

  // The model's tools. The model gets tools.definitions(); a call runs the query, and the token never leaves the client.
  const tools = new ContextTools(client, {
    tools: [{ name: "get_travel_preferences", description: "The user's travel preferences, as they shared them.", categories: ["travel_preferences"], purpose: PURPOSE }],
  });
  say(`tools for the model: ${tools.definitions().map((d) => d.name).join(", ")}`);
  const before = (await tools.call("get_travel_preferences", { question: "How do they like to fly?" })).text;
  say(`the model sees:\n${before}`);

  // The person revokes in their app; the provider pushes a notice through the mediator.
  await stepRevoke(world, outcome.grantId);
  await link.pushNotice(outcome.grantId);

  // The receive loop: notices go to client.receive, acknowledgements go back. Live: run until a signal.
  const loop = await mc.run({ onInbound: (m) => client.receive(m), runForMs: 3_000 });
  say(`receive loop stopped (${loop.stopped}): ${loop.delivered} delivered, ${loop.dropped} dropped`);

  const after = (await tools.call("get_travel_preferences", { question: "How do they like to fly?" })).text;
  say(`after the revocation the model sees: ${after}`);
  return { lines, before, after };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await walkthrough((line) => console.log(line));
}
