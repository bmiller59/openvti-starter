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
import { ContextTools, HcpAgentClient, identityFromKeys, resolveProvider } from "@starter/hcp-agent-client";

const identity = identityFromKeys(signingKey, tspKey);            // or identityFromPeer(didPeerFromSeed(seed, mediatorDid))
const { keys: provider } = await resolveProvider(vtaDid, resolveDid); // the VTA's DID comes from the pairing
const client = new HcpAgentClient({ identity, provider, carrier });  // carrier: moves sealed bytes to the VTA and back

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

## API

| | |
|---|---|
| `new HcpAgentClient(options)` | `identity`, `provider` (VID and TSP public keys), `carrier`; optional `clock`, `newId`, `proofVerifier`, `maxHoldSeconds` (default 600), `observer` (sees whole documents: logs only, never a model), `onRevoked`. |
| `discover()` | The provider's `hcp/*` Type URIs (`trust-task-discovery` 0.4). |
| `requestGrant(ask, { vtaDid, onPairing, onHeld, maxHoldSeconds })` | Sends the request; on each `trust-task-next-step` waits the hint's `retryAfter` (default 5 s when the hint is absent or invalid), counted from receipt, then resubmits a **new document** on the same thread. Returns `granted` (the grant object, no token), `refused` (`code`, `message`) or `held` (gave up waiting). |
| `resubmit(threadId)` | One resubmission. After approval the provider issues a **new token under the same grant**; the client keeps it beside the earlier ones, which stay valid until the grant ends. This is how to recover a lost response: the client never re-sends an earlier document and does not rely on a replay record. |
| `query(grantId, { query, purpose, categories?, maxEntries? })` | `entries` in the provider's relevance order, never filtered, reordered or padded by the client, each with its text, categories and `useUntil`. The client caps each `useUntil` at min(response + 1 h, grant `expiresAt`). On `hcp:invalidToken` it forgets the grant at once. Returns `no-grant` without sending anything once a grant is forgotten. |
| `receive(wire)` | One sealed message from the provider: an `hcp/grants/revoked` notice. Runs the receiving pipeline (sender, freshness, replay, proof, schema), refuses a notice without an `authentication` proof, then: a new `noticeId` purges the grant and calls `onRevoked`; a known one is only acknowledged. Returns the sealed acknowledgement. Processed notices are kept 25 hours, with the signed notice. |
| `grants()`, `grant(id)`, `processedNotices()`, `forgetGrant(id)`, `purgeExpired()` | State, without tokens. |
| `pairingFor(vid, threadId, vtaDid)`, `pairingNumber(threadId, vid)` | The QR text (`{"vid","threadId","vtaDid"}`) and the four-digit number. |
| `resolveProvider(vtaDid, resolveDid)`, `providerFromDidDocument(doc)` | The VTA's keys and `TSPTransport` route from its DID document, wherever the VTA is hosted (its own service or one a community hosts). The resolver is yours to pass. |
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
- `tools.test.ts`: tool results and definitions never contain a token, including after revocation; directives are
  applied in code; the last guard.

To move to a newer reference: copy `src/demo.ts`, `src/validator.ts` and `transcript.golden.txt` from one upstream
commit into `test/reference/`, its `trust-tasks.lock` and `trust-tasks/` into this package, update `SOURCE.json`, and
run `npm run generate -w @starter/hcp-agent-client` (the generated `src/trust-tasks/` is committed).

## What is still to do

- **A live carrier.** The client seals and opens every message; a `Carrier` only moves bytes. A carrier through the
  agent's mediator to the VTA is not written yet. `@openvtc/trust-tasks-tsp` packs a Direct message, so a mediator
  carrier also has to route it (as `@starter/tsp-client` does with `packRouted`), and needs the VTA side of the
  agent's admission, which does not exist yet.
- **A receive loop** on the agent's mediator that hands notices to `receive()` and sends the acknowledgement back.
- **Proofs from a `did:webvh` VTA.** The default verifier accepts `did:key` issuers only; pass a `proofVerifier` that
  resolves the VTA's DID.
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
