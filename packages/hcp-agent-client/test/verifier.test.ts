// Proofs from a VTA whose DID must be resolved (did:webvh): the resolving
// verifier against a fixture DID document, the client using it for replies and
// revocation notices, and the did:webvh log resolver. Hermetic: fixed keys and
// clock, fixture documents, no network.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { respondWith, type TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import { signTrustTask, signerFromPrivateKey, type Signer } from "@openvtc/trust-tasks-proof";
import { packTrustTask, unpackTrustTask } from "@openvtc/trust-tasks-tsp";
import { base58 } from "@scure/base";
import * as discovery from "@openvtc/trust-tasks/trust-task-discovery/0.4/payload";

import {
  HcpAgentClient,
  ResolvingProofVerifier,
  didWebvhResolver,
  didWebvhUrl,
  ed25519KeyOf,
  identityFromKeys,
  iso,
  resolveProvider,
  type Carrier,
  type DidDocument,
  type ResolveDid,
} from "../src/index.js";
import { OTHER_SEED, VTA_SIGNING_SEED, VTA_TSP_SEED, vtaDidDocument } from "./did-fixture.js";

// DEMO ONLY keys: fixed seeds, for these tests and nothing else.
const AGENT_SIGNING_SEED = new Uint8Array(32).fill(0x41);
const AGENT_TSP_SEED = new Uint8Array(32).fill(0x42);

const DOC: DidDocument = vtaDidDocument();
const VTA = DOC.id;
const NOW = Date.parse("2026-11-27T12:00:00Z");
const REVOKED = "https://trusttasks.org/spec/hcp/grants/revoked/0.1";

const resolveFixture: ResolveDid = async (did) => {
  if (did !== VTA) throw new Error(`unknown DID ${did}`);
  return structuredClone(DOC);
};

/** A signer that signs as `vm` of the fixture VTA with `seed`. */
function vtaSigner(seed = VTA_SIGNING_SEED, vm = `${VTA}#key-0`): Signer {
  return { ...signerFromPrivateKey("ed25519", seed), did: VTA, verificationMethod: vm };
}

function doc(extra: Record<string, unknown> = {}): TrustTaskDocument<unknown> {
  return {
    id: "urn:uuid:00000000-0000-4000-8000-000000000001",
    type: discovery.RESPONSE_TYPE_URI,
    issuer: VTA,
    recipient: "did:example:agent",
    issuedAt: iso(NOW),
    threadId: "urn:uuid:00000000-0000-4000-8000-000000000000",
    payload: { supportedTypes: [] },
    ...extra,
  } as TrustTaskDocument<unknown>;
}

const sign = (d: TrustTaskDocument<unknown>, signer = vtaSigner(), proofPurpose = "authentication", created = new Date(NOW)) =>
  signTrustTask(d, signer, { proofPurpose, created });

function verifier(resolveDid: ResolveDid = resolveFixture, now = NOW) {
  let calls = 0;
  const v = new ResolvingProofVerifier({
    resolveDid: async (did) => {
      calls++;
      return resolveDid(did);
    },
    now: () => now,
  });
  return { v, calls: () => calls };
}

test("fixture: the DID document's keys are the test seeds' public keys", () => {
  assert.deepEqual(ed25519KeyOf(DOC, "#key-0", "authentication"), ed25519.getPublicKey(VTA_SIGNING_SEED));
  assert.deepEqual(ed25519KeyOf(DOC, `${VTA}#key-assert`, "assertionMethod"), ed25519.getPublicKey(OTHER_SEED));
});

test("a did:webvh proof by a key listed under its purpose verifies, over the document as received", async () => {
  const { v, calls } = verifier();
  const signed = sign(doc());
  assert.deepEqual(await v.verifyDetailed(signed), { valid: true });
  assert.equal(calls(), 1);
  // Any change to what arrived breaks it.
  const tampered = { ...signed, payload: { supportedTypes: ["https://trusttasks.org/spec/hcp/grants/request/0.1"] } };
  assert.equal((await v.verifyDetailed(tampered)).failure, "signatureInvalid");
});

test("refused: a key not listed under the proof's purpose, one another DID controls, or a key the document lacks", async () => {
  const { v } = verifier();
  // key-assert is an assertionMethod key: it cannot sign under authentication.
  const wrongPurpose = await v.verifyDetailed(sign(doc(), vtaSigner(OTHER_SEED, `${VTA}#key-assert`)));
  assert.equal(wrongPurpose.failure, "signatureInvalid");
  // ...but it can under assertionMethod.
  assert.equal((await v.verifyDetailed(sign(doc(), vtaSigner(OTHER_SEED, `${VTA}#key-assert`), "assertionMethod"))).valid, true);
  // key-foreign is listed under authentication but controlled by someone else.
  assert.equal((await v.verifyDetailed(sign(doc(), vtaSigner(OTHER_SEED, `${VTA}#key-foreign`)))).failure, "signatureInvalid");
  // key-0 named, another key signing.
  assert.equal((await v.verifyDetailed(sign(doc(), vtaSigner(OTHER_SEED)))).failure, "signatureInvalid");
  // A key-agreement key never signs.
  assert.equal(ed25519KeyOf(DOC, `${VTA}#key-tsp`, "keyAgreement"), undefined);
  assert.equal(ed25519KeyOf(DOC, `${VTA}#key-tsp`, "authentication"), undefined);
});

test("refused: an unresolvable DID, a document for another DID, an issuer the method does not belong to", async () => {
  assert.equal((await verifier(async () => { throw new Error("offline"); }).v.verifyDetailed(sign(doc()))).failure, "signatureInvalid");
  assert.equal((await verifier(async () => ({ ...structuredClone(DOC), id: "did:example:other" })).v.verifyDetailed(sign(doc()))).failure, "issuerMismatch");
  const other = "did:webvh:QmOther:vta.example.test";
  const otherIssuer = sign(doc({ issuer: other }), { ...vtaSigner(), did: other });
  assert.equal((await verifier().v.verifyDetailed(otherIssuer)).failure, "issuerMismatch");
});

test("refused: no proof, another suite, created in the future, expired, a proof @context unlike the document's", async () => {
  const { v, calls } = verifier();
  assert.equal((await v.verifyDetailed(doc())).failure, "malformedProof");
  const signed = sign(doc()) as TrustTaskDocument<unknown> & { proof: Record<string, unknown> };
  assert.equal((await v.verifyDetailed({ ...signed, proof: { ...signed.proof, cryptosuite: "ecdsa-jcs-2019" } })).failure, "unsupportedCryptosuite");
  assert.equal((await v.verifyDetailed(sign(doc(), vtaSigner(), "authentication", new Date(NOW + 120_000)))).failure, "malformedProof");
  assert.equal((await v.verifyDetailed({ ...signed, proof: { ...signed.proof, expires: iso(NOW - 1000) } })).failure, "malformedProof");
  assert.equal((await v.verifyDetailed({ ...signed, proof: { ...signed.proof, "@context": ["https://w3id.org/security/data-integrity/v2"] } })).failure, "malformedProof");
  assert.equal(calls(), 0, "nothing resolved for a proof that fails before the key is needed");
});

test("a did:key issuer is checked by the library's did:key verifier, without resolving", async () => {
  const { v, calls } = verifier();
  const key = signerFromPrivateKey("ed25519", OTHER_SEED);
  assert.equal(await v.verify(sign(doc({ issuer: key.did }), key)), true);
  assert.equal(await v.verify({ ...sign(doc({ issuer: key.did }), key), payload: { supportedTypes: ["x"] } }), false);
  assert.equal(calls(), 0);
});

// ── The client with a did:webvh provider ─────────────────────────────────────

/** A provider at the fixture did:webvh that answers discovery, signing with `signer`. */
async function webvhProvider(signer: Signer) {
  const { keys: provider } = await resolveProvider(VTA, resolveFixture);
  assert.deepEqual(provider.encryptionKey, x25519.getPublicKey(VTA_TSP_SEED));
  const agent = identityFromKeys(AGENT_SIGNING_SEED, AGENT_TSP_SEED);
  const agentPub = { signingKey: ed25519.getPublicKey(AGENT_SIGNING_SEED), encryptionKey: x25519.getPublicKey(AGENT_TSP_SEED) };
  let n = 0;
  const newId = () => `urn:uuid:00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const carrier: Carrier = async (wire) => {
    const req = await unpackTrustTask(wire, { recipientVid: VTA, keys: { receiverDecryptionKey: VTA_TSP_SEED, senderSigningKey: agentPub.signingKey } });
    const reply = respondWith(req.document as never, newId(), { supportedTypes: [`${REVOKED}`] }, () => iso(NOW));
    return packTrustTask(sign(reply as never, signer) as never, {
      senderVid: VTA,
      receiverVid: agent.vid,
      keys: { senderSigningKey: VTA_SIGNING_SEED, receiverEncryptionKey: agentPub.encryptionKey },
    });
  };
  const notice = async (purpose = "authentication") =>
    packTrustTask(
      sign(
        {
          id: newId(),
          type: `${REVOKED}#request`,
          issuer: VTA,
          recipient: agent.vid,
          issuedAt: iso(NOW),
          payload: { grantId: "urn:uuid:00000000-0000-4000-8000-0000000000aa", noticeId: newId(), revokedAt: iso(NOW - 1000) },
        } as never,
        signer,
        purpose,
      ) as never,
      { senderVid: VTA, receiverVid: agent.vid, keys: { senderSigningKey: VTA_SIGNING_SEED, receiverEncryptionKey: agentPub.encryptionKey } },
    );
  const client = (resolveDid?: ResolveDid) =>
    new HcpAgentClient({
      identity: agent,
      provider,
      carrier,
      resolveDid,
      clock: { now: () => NOW, issue: () => iso(NOW), sleep: async () => {} },
      newId,
    });
  return { client, notice };
}

test("client: replies from a did:webvh VTA verify with resolveDid, and are refused by the did:key default", async () => {
  const p = await webvhProvider(vtaSigner());
  assert.deepEqual(await p.client(resolveFixture).discover(), [REVOKED]);
  await assert.rejects(p.client().discover(), /proof does not verify/);
  const forged = await webvhProvider(vtaSigner(OTHER_SEED));
  await assert.rejects(forged.client(resolveFixture).discover(), /proof does not verify/);
});

test("client: a revocation notice from a did:webvh VTA is processed and acknowledged; unverifiable ones are not", async () => {
  const p = await webvhProvider(vtaSigner());
  const ok = p.client(resolveFixture);
  assert.ok(await ok.receive(await p.notice()));
  assert.equal(ok.processedNotices().length, 1);

  const noResolver = p.client();
  await noResolver.receive(await p.notice());
  assert.equal(noResolver.processedNotices().length, 0, "the did:key default cannot verify it");

  const forged = await webvhProvider(vtaSigner(OTHER_SEED));
  const c = forged.client(resolveFixture);
  await c.receive(await forged.notice());
  assert.equal(c.processedNotices().length, 0);
});

// ── did:webvh log resolution ─────────────────────────────────────────────────

test("didWebvhUrl: the log's location from the DID, a port and a path included", () => {
  assert.equal(didWebvhUrl("did:webvh:QmScid:example.test"), "https://example.test/.well-known/did.jsonl");
  assert.equal(didWebvhUrl("did:webvh:QmScid:example.test%3A8443:members:alex"), "https://example.test:8443/members/alex/did.jsonl");
  assert.equal(didWebvhUrl("did:webvh:QmScid:example.test", "did-witness.json"), "https://example.test/.well-known/did-witness.json");
  assert.throws(() => didWebvhUrl("did:web:example.test"), /not a did:webvh/);
});

test("didWebvhResolver: a log that verifies resolves; a tampered log or another DID is refused", async () => {
  const { createDID, multibaseEncode, MultibaseEncoding, prepareDataForSigning } = await import("didwebvh-ts");
  const pub = `z${base58.encode(new Uint8Array([0xed, 0x01, ...ed25519.getPublicKey(VTA_SIGNING_SEED)]))}`;
  const vm = `did:key:${pub}#${pub}`;
  const signer = {
    getVerificationMethodId: () => vm,
    sign: async (input: { document: unknown; proof: Record<string, unknown> }) => ({
      proofValue: multibaseEncode(ed25519.sign(await prepareDataForSigning(input.document as never, input.proof as never), VTA_SIGNING_SEED), MultibaseEncoding.BASE58_BTC),
    }),
  };
  const verify = { verify: async (s: Uint8Array, m: Uint8Array, k: Uint8Array) => ed25519.verify(s, m, k) };
  const made = await createDID({
    address: "vta.example.test",
    signer: signer as never,
    verifier: verify,
    updateKeys: [pub],
    verificationMethods: [{ type: "Multikey", publicKeyMultibase: pub, purpose: "authentication" } as never],
  });
  const log = made.log.map((e: unknown) => JSON.stringify(e)).join("\n");
  const fetched: string[] = [];
  const files = new Map([[didWebvhUrl(made.did), log]]);
  const resolve = didWebvhResolver(async (url) => {
    fetched.push(url);
    return files.get(url);
  });
  const resolved = await resolve(made.did);
  assert.equal(resolved.id, made.did);
  assert.deepEqual(fetched, [didWebvhUrl(made.did), didWebvhUrl(made.did, "did-witness.json")]);

  const forged = JSON.parse(log.split("\n")[0]!);
  forged.state.service = [{ id: "#evil", type: "TSPTransport", serviceEndpoint: "did:example:attacker" }];
  files.set(didWebvhUrl(made.did), JSON.stringify(forged));
  await assert.rejects(resolve(made.did));
  files.delete(didWebvhUrl(made.did));
  await assert.rejects(resolve(made.did), /no did.jsonl/);
});
