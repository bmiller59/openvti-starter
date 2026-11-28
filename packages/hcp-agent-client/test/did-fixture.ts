// A fixture DID document for a did:webvh VTA, built from fixed DEMO ONLY seeds
// (32 repeated bytes) rather than stored, so no key literal sits in the tree.
// It lists:
//   #key-0        Ed25519, authentication, controlled by the VTA (signs replies and notices)
//   #key-assert   Ed25519, assertionMethod only
//   #key-foreign  Ed25519, listed under authentication but controlled by another DID
//   #key-tsp      X25519, keyAgreement (TSP)
// and a TSPTransport service naming a mediator.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

import type { DidDocument } from "../src/index.js";

export const VTA_SIGNING_SEED = new Uint8Array(32).fill(0x31);
export const VTA_TSP_SEED = new Uint8Array(32).fill(0x32);
export const OTHER_SEED = new Uint8Array(32).fill(0x33);
export const VTA_DID = "did:webvh:QmFakeScidHcp:vta.example.test:members:alex";

const multikey = (codec: number[], key: Uint8Array) => `z${base58.encode(new Uint8Array([...codec, ...key]))}`;

export function vtaDidDocument(): DidDocument {
  const did = VTA_DID;
  const signing = multikey([0xed, 0x01], ed25519.getPublicKey(VTA_SIGNING_SEED));
  const other = multikey([0xed, 0x01], ed25519.getPublicKey(OTHER_SEED));
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: [
      { id: `${did}#key-0`, type: "Multikey", controller: did, publicKeyMultibase: signing },
      { id: `${did}#key-assert`, type: "Multikey", controller: did, publicKeyMultibase: other },
      { id: `${did}#key-foreign`, type: "Multikey", controller: "did:example:someone-else", publicKeyMultibase: other },
      { id: `${did}#key-tsp`, type: "Multikey", controller: did, publicKeyMultibase: multikey([0xec, 0x01], x25519.getPublicKey(VTA_TSP_SEED)) },
    ],
    authentication: ["#key-0", `${did}#key-foreign`],
    assertionMethod: [`${did}#key-assert`],
    keyAgreement: [`${did}#key-tsp`],
    service: [{ id: `${did}#tsp`, type: "TSPTransport", serviceEndpoint: "did:example:mediator" }],
  } as DidDocument;
}
