// The agent's own identity (its VID, signing and TSP keys), the provider it
// talks to, and the pairing the person uses to bind an approval to this agent.

import { createHash } from "node:crypto";

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { signerFromPrivateKey, type Signer } from "@openvtc/trust-tasks-proof";

/** The agent client's identity: one VID, used as the Trust Task `issuer` and the TSP sender. */
export interface AgentIdentity {
  vid: string;
  /** Signs every document the client issues (`proofPurpose: authentication`). */
  signer: Signer;
  /** Ed25519 private key: signs sealed TSP messages. */
  signingKey: Uint8Array;
  /** X25519 private key: opens TSP messages sealed to this VID. */
  decryptionKey: Uint8Array;
}

/** The public keys of a peer the client exchanges TSP messages with. */
export interface PeerKeys {
  vid: string;
  /** Ed25519 public key: verifies the peer's TSP signature. */
  signingKey: Uint8Array;
  /** X25519 public key: seals messages to the peer. */
  encryptionKey: Uint8Array;
}

/** A `did:key` identity from an Ed25519 signing key and an X25519 TSP key (each 32 bytes). */
export function identityFromKeys(signingKey: Uint8Array, decryptionKey: Uint8Array): AgentIdentity {
  if (signingKey.length !== 32 || decryptionKey.length !== 32) throw new Error("each key is 32 bytes");
  const signer = signerFromPrivateKey("ed25519", signingKey);
  return { vid: signer.did, signer, signingKey, decryptionKey };
}

/**
 * A `did:peer:2` identity from the fields `@starter/tsp-client`'s `didPeerFromSeed`
 * returns: a VID whose `TSPTransport` service names a mediator, so a provider
 * can push notices (`hcp/grants/revoked`) to it.
 */
export function identityFromPeer(peer: { did: string; seed: Uint8Array; decryptionKey: Uint8Array; signer: Signer }): AgentIdentity {
  return { vid: peer.did, signer: peer.signer, signingKey: peer.seed, decryptionKey: peer.decryptionKey };
}

/** The public half of an identity, as a peer sees it. */
export function publicKeysOf(identity: AgentIdentity): PeerKeys {
  return {
    vid: identity.vid,
    signingKey: ed25519.getPublicKey(identity.signingKey),
    encryptionKey: x25519.getPublicKey(identity.decryptionKey),
  };
}

/**
 * What the person's wallet scans to bind its approval to this agent and this
 * grant request: the agent's VID, the request's `threadId`, and the VTA's DID.
 */
export interface Pairing {
  vid: string;
  threadId: string;
  vtaDid: string;
  /** The four digits the person types into the wallet. */
  number: string;
  /** The QR code's text: JSON with `vid`, `threadId` and `vtaDid`, keys in that order. */
  qr: string;
}

/**
 * The four-digit match number for a grant request on `threadId` from `vid`:
 * the first 4 bytes of `SHA-256(UTF-8(threadId) || 0x00 || UTF-8(vid))`, read
 * as an unsigned big-endian 32-bit integer, modulo 10000, as 4 decimal digits
 * with leading zeros. `threadId` is the full `urn:uuid:…`.
 *
 * The same layout as Keyring's `hcpMatchNumber`
 * (`packages/core/src/modules/connected-agents/hcp/matchNumber.ts`), checked
 * against its shared vectors in `test/vectors/match-number.json`.
 */
export function pairingNumber(threadId: string, vid: string): string {
  const digest = createHash("sha256")
    .update(Buffer.concat([Buffer.from(threadId, "utf8"), Buffer.from([0]), Buffer.from(vid, "utf8")]))
    .digest();
  return String(digest.readUInt32BE(0) % 10000).padStart(4, "0");
}

/** The pairing for a grant request on `threadId`. */
export function pairingFor(vid: string, threadId: string, vtaDid: string): Pairing {
  return { vid, threadId, vtaDid, number: pairingNumber(threadId, vid), qr: JSON.stringify({ vid, threadId, vtaDid }) };
}
