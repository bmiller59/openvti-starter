# @starter/hcp-agent-client

The AI agent's side of HCP, the [Human Context Protocol](https://github.com/loyalagents/hcp-spec/blob/b790561/spec/2.0-draft-3/specification.md)
(2.0-draft-3), carried as `hcp/*` Trust Tasks over TSP 1.0 (binding `tsp/0.3`). In HCP terms it is a
**Context Client**. It:

1. asks the person's provider (their VTA) for a grant with `hcp/grants/request`, shows a pairing QR and number, and
   waits through the hold, resubmitting on the same thread;
2. queries the person's context with `hcp/entries/query` under the grant's token;
3. receives `hcp/grants/revoked` notices, deduplicates them on `noticeId`, drops the grant's token and every copy
   disclosed under it, and acknowledges;
4. gives a model **tools** ("get the user's travel preferences") that run the query behind the scenes. The token never
   enters the model's context (HCP 10.5).

It is an optional client that runs beside the stack, never inside the VTA. It is **tested against the shared HCP
reference provider and has not yet run against a live VTA** (see [What is still to do](#what-is-still-to-do)). Node 22+.

## Example

```ts
import { ContextTools, HcpAgentClient, didWebvhResolver, identityFromKeys, resolveProvider } from "@starter/hcp-agent-client";

const identity = identityFromKeys(signingKey, tspKey);            // or identityFromPeer(didPeerFromSeed(seed, mediatorDid))
const resolveDid = didWebvhResolver(fetchText);                      // or any resolver for the VTA's DID method
const { keys: provider } = await resolveProvider(vtaDid, resolveDid); // the VTA's DID comes from the pairing
const client = new HcpAgentClient({ identity, provider, carrier, resolveDid }); // carrier: moves sealed bytes to the VTA and back

const outcome = await client.requestGrant(
  {
    access: [{
      type: "https://hcp.example/spec/authorization/context-access",
      actions: ["read"],
      categories: ["travel_preferences"],
      purposes: [{ code: "https://purposes.example/travel-booking", description: "Book trips that match how you like to travel" }],
    }],
  },
  { vtaDid, onPairing: (p) => console.log(`Scan ${p.qr} and type ${p.number}`) },
);
if (outcome.kind !== "granted") throw new Error(`no grant: ${outcome.kind}`);

const tools = new ContextTools(client, {
  tools: [{
    name: "get_travel_preferences",
    description: "The user's travel preferences, as they shared them.",
    categories: ["travel_preferences"],
    purpose: "https://purposes.example/travel-booking",
  }],
});
// Give tools.definitions() to the model. When it calls a tool:
const result = await tools.call("get_travel_preferences", { question: "How do they like to fly?" });
// result.text: the entries, the purpose and each one's "use until". Never the token.

// Notices arrive on the agent's own TSP route (its mediator):
const ack = await client.receive(sealedNotice);   // send `ack` back to the VTA, when present
```

Through the agent's mediator, a `MediatorCarrier` is the carrier and runs the receive loop:

```ts
// Log in to the mediator and open the WebSocket (@openvtc/pnm-core, as @starter/tsp-client does):
const { link, mediator, close } = await connectMediatorLink({ identity, mediatorDid, providerDid: vtaDid });
const mc = new MediatorCarrier({ identity, mediator, provider, link });
const client = new HcpAgentClient({ identity, provider, carrier: mc.carrier, resolveDid });
await mc.relate();                                                        // TSP relationship with the VTA
const loop = mc.run({ onInbound: (m) => client.receive(m), signal });    // notices in, acknowledgements back
```

A runnable version of all of this, offline, is [`examples/walkthrough.ts`](examples/walkthrough.ts): identity, the
mediator carrier, a grant held and then approved, a query through the tool layer, and a revocation notice through the
receive loop, against the vendored reference provider behind a fake mediator (the same setup as the tests). Four marked
lines say what to swap for a live VTA. `test/example.test.ts` runs it, so it stays in step with the API.

```sh
npm run example -w @starter/hcp-agent-client
```

## API

| | |
|---|---|
| `new HcpAgentClient(options)` | `identity`, `provider` (VID and TSP public keys), `carrier` (`(wire, { id, threadId }) => reply`); optional `resolveDid` (so a did:webvh VTA's proofs verify), `clock`, `newId`, `proofVerifier` (default: `ResolvingProofVerifier` over `resolveDid`, else did:key only), `maxHoldSeconds` (default 600), `observer` (sees whole documents: logs only, never a model), `onRevoked`. |
| `discover()` | The provider's `hcp/*` Type URIs (`trust-task-discovery` 0.4). |
| `requestGrant(ask, { vtaDid, onPairing, onHeld, maxHoldSeconds })` | Sends the request; on each `trust-task-next-step` waits the hint's `retryAfter` (default 5 s when the hint is absent or invalid), counted from receipt, then resubmits a **new document** on the same thread. Returns `granted` (the grant object, no token), `refused` (`code`, `message`) or `held` (gave up waiting). |
| `resubmit(threadId)` | One resubmission. After approval the provider issues a **new token under the same grant**; the client keeps it beside the earlier ones, which stay valid until the grant ends. This is how to recover a lost response: the client never re-sends an earlier document and does not rely on a replay record. |
| `query(grantId, { query, purpose, categories?, maxEntries? })` | `entries` in the provider's relevance order, never filtered, reordered or padded by the client, each with its text, categories and `useUntil`. The client caps each `useUntil` at min(response + 1 h, grant `expiresAt`). On `hcp:invalidToken` it forgets the grant at once. Returns `no-grant` without sending anything once a grant is forgotten. |
| `receive(wire)` | One sealed message from the provider: an `hcp/grants/revoked` notice. Runs the receiving pipeline (sender, freshness, replay, proof, schema), refuses a notice without an `authentication` proof, then: a new `noticeId` purges the grant and calls `onRevoked`; a known one is only acknowledged. Returns the sealed acknowledgement. Processed notices are kept 25 hours, with the signed notice. |
| `grants()`, `grant(id)`, `processedNotices()`, `forgetGrant(id)`, `purgeExpired()` | State, without tokens. |
| `pairingFor(vid, threadId, vtaDid)`, `pairingNumber(threadId, vid)` | The QR text (`{"vid","threadId","vtaDid"}`) and the four-digit number. |
| `resolveProvider(vtaDid, resolveDid)`, `providerFromDidDocument(doc)` | The VTA's keys and `TSPTransport` route from its DID document, wherever the VTA is hosted (its own service or one a community hosts). The resolver is yours to pass. |
| `new MediatorCarrier({ identity, mediator, provider, link })` | Carries the client's messages through the agent's mediator. `carrier` wraps each Direct TSP message in a Routed message to the mediator with the provider as the remaining hop, and waits at most `replyTimeoutMs` (default 30 s) for the reply on the request's thread. `relate()` sends the TSP relationship invite and waits for the accept. `wrap` / `unwrap`: inbound frames are the provider's Direct message, or that message in a Nested (or hop-less Routed) message from the mediator. `link` is a `MediatorLink` (`send(frame)`, `receive(timeoutMs)`); `connectMediatorLink` makes one. |
| `connectMediatorLink({ identity, mediatorDid, providerDid, login?, allowInsecure?, webSocketImpl?, maxQueue? })` | Logs in to the mediator and opens its WebSocket with `@openvtc/pnm-core`'s `connectMediatorSession` (the same login `@starter/tsp-client` uses), and resolves the mediator's TSP keys from its DID document. Returns `{ link, mediator, close }`. A `did:key` logs in with the X25519 key its DID document derives (`didKeyLogin`); a `did:peer:2` passes `login` (`keyAgreementKid`, `secretJwk` from `didPeerFromSeed`). A closed socket is not reopened: reads and sends then throw, the receive loop backs off and gives up, and you connect again. |
| `new SocketMediatorLink(socket, { maxQueue, onDrop })` | The `MediatorLink` over an open socket (`sendBinary`, `onInboundTsp`, `close`, `isOpen`: pnm-core's `MediatorConnection`). Every inbound TSP frame goes on a queue (default at most 1000, the oldest dropped beyond that) that `receive` drains. The mediator deletes its copy once the frame is queued, so frames queued and not yet read are lost if the process ends; the provider re-sends an unacknowledged notice and the client de-duplicates on `noticeId`. |
| `mc.run({ onInbound, signal, runForMs, minBackoffMs, maxBackoffMs, maxConsecutiveFailures })` | The receive loop: each read waits at most `pollTimeoutMs` (default 5 s); a message the provider pushes goes to `onInbound` (usually `client.receive`) and its reply goes back through the mediator; a link failure backs off from 500 ms, doubling to at most 30 s, and the loop rejects after 5 in a row; an unreadable frame, a reply nobody waits for, or a message `onInbound` throws on is dropped (`onDrop`). Stops on the signal or after `runForMs`. A notice read while a request waits is kept for the loop (at most `maxInbox`, default 100). |
| `ResolvingProofVerifier({ resolveDid })` | Verifies Data Integrity proofs from any DID `resolveDid` resolves: the key must be listed in the issuer's DID document under the proof's purpose and controlled by the issuer; the signature is checked over the document as received (`eddsa-jcs-2022`, Ed25519). did:key issuers go to the library's verifier, unresolved. Never throws; `verifyDetailed` says why a proof failed. |
| `didWebvhResolver(fetchText)`, `resolveDidWebvhLog(did, log, witness?)`, `didWebvhUrl(did)` | A `resolveDid` for did:webvh: fetches `did.jsonl` (and `did-witness.json`, when there is one) with your `fetchText` and **verifies the log** with `didwebvh-ts` (SCID, entry-hash chain, update-key proofs, witnesses) before using its document. |
| `ed25519KeyOf(doc, vmId, purpose)` | The Ed25519 key a DID document lists under a signing purpose, controlled by the document's DID. |
| `identityFromKeys`, `identityFromPeer`, `publicKeysOf` | The agent's identity: a `did:key`, or the `did:peer:2` with a mediator route that `@starter/tsp-client`'s `didPeerFromSeed` makes. |

Every document the client issues is signed with `proofPurpose: authentication`. Every reply is checked before use:
from the provider, on the thread, signed (unless it is a refusal the receiver's library pipeline builds unsigned), an
`authentication` proof that verifies, and a payload valid against its schema.

## The tool layer (HCP 10.5)

`ContextTools` turns tool specs (a name, a description, the HCP categories it reads, the purpose) into tool definitions
in the shape MCP takes, and runs a call:

- it picks the active grant that covers the tool's categories and purpose; if there is none, or the grant has ended, the
  model gets one fixed "no access" text and nothing is sent;
- the client builds the query and presents the token; the tool layer never reads it;
- the result has only the entries' text, categories and `useUntil`, and the purpose. No token, no `ref`, no grant id;
- the provider's directives are passed to your `applyDirectives` hook, in code, and never to the model. A deny turns the
  result into a refusal;
- a last check compares every result with every token the client holds and withholds one that contains any.

`toMcpResult(result)` gives an MCP `CallToolResult`.

## Tests

```sh
npm test -w @starter/hcp-agent-client
```

The tests are hermetic: no network, fixed keys, identifiers and clock. They run the client against the **reference
provider** of the Trust Tasks repository's
[`examples/hcp-demo-ts`](https://github.com/trustoverip/dtgwg-trust-tasks-tf/tree/main/examples/hcp-demo-ts), the shared
test vectors for every HCP implementation, vendored unmodified in `test/reference/` at the commit in
[`test/reference/SOURCE.json`](test/reference/SOURCE.json). A test checks the vendored files against that commit's hashes.
The client takes the reference Context Client's place and every message is a real sealed TSP 1.0 message.

- `golden.test.ts`: the client drives the eight steps of the shared scenario and the run prints the upstream
  `transcript.golden.txt` byte for byte.
- `client.test.ts`: the hold and resubmission, a new token on resubmission with both tokens valid, the authentication
  proofs, the pairing, query order and the `useUntil` cap, copies dropped at `useUntil`, revocation and purge, a
  duplicate notice, `hcp:invalidToken` before any notice, decline and an expired hold, the reply checks, a notice with
  the wrong proof purpose, the next step's hint, and the provider's keys from a DID document.
- `verifier.test.ts`: proofs from a did:webvh VTA against a fixture DID document (`did-fixture.ts`, built from fixed
  seeds): the key under the proof's purpose, the controller, an unresolvable DID, the proof's own checks; the client's
  replies and revocation notices from that VTA, refused without `resolveDid`; and a did:webvh log that verifies, is
  tampered with, or is missing.
- `mediator.test.ts`: the mediator carrier against a fake mediator (`fake-mediator.ts`) in front of the reference provider, with direct and
  nested delivery: the relationship invite, a held grant and a query; wrap and unwrap; a notice through the receive
  loop with its acknowledgement; a notice that arrives during a request; the reply timeout; backoff and giving up;
  dropped frames; the abort signal.
- `link.test.ts`: `SocketMediatorLink` over a fake socket (queued and waiting reads, the bounded wait, a full queue, a
  closed socket) and the `did:key` login key.
- `live-mediator.test.ts`: **opt-in, skipped unless `HCP_LIVE_MEDIATOR_DID` is set.** The client and the reference
  provider each log in to a real mediator with `connectMediatorLink` and exchange sealed TSP 1.0 messages through it:
  the relationship invite and accept, a held grant, a query, a revocation notice and its acknowledgement; and a notice
  pushed while the agent is logged out, delivered when it logs in again. `HCP_LIVE_MEDIATOR_INSECURE=1` allows an
  `http://` mediator (a local test mediator only); `HCP_LIVE_REPORT=<prefix>` writes how each frame arrived.
- `example.test.ts`: runs `examples/walkthrough.ts` end to end.
- `tools.test.ts`: tool results and definitions never contain a token, including after revocation; directives are
  applied in code; the last guard.

To move to a newer reference: copy `src/demo.ts`, `src/validator.ts` and `transcript.golden.txt` from one upstream
commit into `test/reference/`, its `trust-tasks.lock` and `trust-tasks/` into this package, update `SOURCE.json`, and
run `npm run generate -w @starter/hcp-agent-client` (the generated `src/trust-tasks/` is committed).

## What is still to do

- **More live mediator runs.** `live-mediator.test.ts` has passed against the affinidi mediator 0.57.0 (its upstream
  test-mediator fixture: in-memory store, `did:peer` identity, plain HTTP, open access list), with `did:key` parties.
  That mediator delivered every message as the peer sealed it (the Routed layer removed, never wrapped in a Nested
  message), and delivered a notice queued while the agent was logged out on its next login. After a logout it also
  re-delivered the last frame read before it, once; the carrier drops that as a reply nobody waits for. Not run: the
  production mediator binary with Redis, `MODE=tunnel` over https, the 0.48.0 the starter pins, a `did:peer:2` agent,
  and a live VTA.
- **The VTA side.** Holding and approving `hcp/grants/request`, `hcp/entries/query` and the revocation notices are being
  built in the VTA. Until they land, this package runs only against the reference provider.
- **Directives (P1).** `applyDirectives` is the hook; no directive action is interpreted yet.

## Assumptions and open questions

- **The pairing number** is Keyring's match number: the first 4 bytes of
  `SHA-256(UTF-8(threadId) || 0x00 || UTF-8(vid))` as an unsigned big-endian 32-bit integer, modulo 10000, four digits
  with leading zeros (Keyring's `packages/core/src/modules/connected-agents/hcp/matchNumber.ts`). Keyring's five shared
  vectors are vendored unmodified in [`test/vectors/match-number.json`](test/vectors/match-number.json), and
  `client.test.ts` checks `pairingNumber` against every one.
- **The `useUntil` cap.** The client applies min(response + 1 h, grant `expiresAt`) to every copy. The reference
  provider writes response + 1 h even when the grant ends sooner; the client's cap covers that.
- **Resubmission and the replay record.** A provider's library may answer a re-delivered copy of an earlier
  `hcp/grants/request` from its replay record. The client never relies on it: every attempt is a new document.
- **Notices from the provider only.** The client accepts notices only from the provider it asked, with an
  `authentication` proof, and acknowledges a notice for a grant it no longer holds.
