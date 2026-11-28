// Proofs from a provider whose DID must be resolved (a did:webvh VTA, a VTA a
// community hosts, any DID method the injected resolver knows).
//
// `@openvtc/trust-tasks-proof`'s verifier reads the key out of a did:key and
// nothing else. This one keeps it for did:key issuers and, for every other
// issuer, resolves the DID through the `resolveDid` it is given, takes the key
// the document lists under the proof's purpose, and checks the signature over
// the document as received (never a pruned or re-serialised copy).
//
// The rules are the library verifier's: `DataIntegrityProof`, a signing
// purpose, `created` within the clock skew, `expires` not passed, the
// verification method controlled by the document's `issuer`, a proof
// `@context` equal to the document's, and Ed25519 checked the strict way the
// Rust, Go and Dart verifiers check it. Only `eddsa-jcs-2022` with an Ed25519
// `Multikey` (or `Ed25519VerificationKey2020`) is accepted from a resolved
// document; that is what a VTA signs with.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import type { ProofVerifier, TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import {
  DataIntegrityProofVerifier,
  DEFAULT_CLOCK_SKEW_MS,
  SIGNING_PURPOSES,
  canonicalBytes,
  fromMultibase,
  type ProofVerification,
} from "@openvtc/trust-tasks-proof";

import { ed25519KeyOf, type DidDocument, type ResolveDid } from "./provider.js";

export interface ResolvingProofVerifierOptions {
  /** Resolves a non-did:key issuer to its DID document. Cache in it if you need to; it is called once per proof. */
  resolveDid: ResolveDid;
  /** The clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Allowance on a proof's `created`. Defaults to the library's 60 s. */
  clockSkewMs?: number;
}

/** A {@link ProofVerifier} for did:key issuers and for any DID `resolveDid` can resolve. Never throws. */
export class ResolvingProofVerifier implements ProofVerifier {
  private readonly resolveDid: ResolveDid;
  private readonly now: () => number;
  private readonly clockSkewMs: number;
  private readonly didKey: DataIntegrityProofVerifier;

  constructor(options: ResolvingProofVerifierOptions) {
    this.resolveDid = options.resolveDid;
    this.now = options.now ?? Date.now;
    this.clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.didKey = new DataIntegrityProofVerifier({ now: this.now, clockSkewMs: this.clockSkewMs });
  }

  async verify<P>(doc: TrustTaskDocument<P>): Promise<boolean> {
    return (await this.verifyDetailed(doc)).valid;
  }

  /** Verify `doc`'s proof and say why it failed, if it did. The detail is for logs, never for the peer. */
  async verifyDetailed<P>(doc: TrustTaskDocument<P>): Promise<ProofVerification> {
    const issuer = (doc as { issuer?: unknown }).issuer;
    if (typeof issuer === "string" && issuer.startsWith("did:key:")) return this.didKey.verifyDetailed(doc);

    const p = (doc as { proof?: unknown }).proof as Record<string, unknown> | undefined;
    if (p === undefined || p === null || typeof p !== "object" || Array.isArray(p)) return fail("malformedProof", "the document carries no single proof object");
    if (p.type !== "DataIntegrityProof") return fail("malformedProof", "proof type must be DataIntegrityProof");
    for (const member of ["cryptosuite", "verificationMethod", "proofPurpose", "proofValue"]) {
      if (typeof p[member] !== "string" || p[member] === "") return fail("malformedProof", `proof.${member} must be a non-empty string`);
    }
    const purpose = p.proofPurpose as string;
    const vm = p.verificationMethod as string;
    if (!SIGNING_PURPOSES.includes(purpose)) return fail("malformedProof", `proofPurpose ${purpose} names no signing relationship`);
    if (p.cryptosuite !== "eddsa-jcs-2022") return fail("unsupportedCryptosuite", String(p.cryptosuite));
    const now = this.now();
    if (p.created !== undefined) {
      const at = typeof p.created === "string" ? instant(p.created) : undefined;
      if (at === undefined) return fail("malformedProof", "proof.created is not a dateTimeStamp with Z or an offset");
      if (at > now + Math.max(0, this.clockSkewMs)) return fail("malformedProof", "proof.created is in the future");
    }
    if (p.expires !== undefined) {
      const at = typeof p.expires === "string" ? instant(p.expires) : undefined;
      if (at === undefined) return fail("malformedProof", "proof.expires is not a dateTimeStamp with Z or an offset");
      if (now > at) return fail("malformedProof", "proof.expires has passed");
    }
    if (typeof issuer !== "string") return fail("issuerMismatch", "the document carries a proof but no issuer");
    if (vm.split("#", 1)[0] !== issuer) return fail("issuerMismatch", `verificationMethod is not controlled by ${issuer}`);
    if (Object.prototype.hasOwnProperty.call(p, "@context")) {
      const docContext = (doc as Record<string, unknown>)["@context"];
      if (docContext === undefined || !equalBytes(canonicalBytes(p["@context"]), canonicalBytes(docContext))) {
        return fail("malformedProof", "proof @context does not equal the document's");
      }
    }

    let didDoc: DidDocument;
    try {
      didDoc = await this.resolveDid(issuer);
    } catch (e) {
      return fail("signatureInvalid", `${issuer} did not resolve: ${(e as Error).message}`);
    }
    if (didDoc?.id !== issuer) return fail("issuerMismatch", `${issuer} resolved to a document for ${String(didDoc?.id)}`);
    const key = ed25519KeyOf(didDoc, vm, purpose);
    if (key === undefined) return fail("signatureInvalid", `${issuer} lists no Ed25519 key ${vm} under ${purpose}, controlled by ${issuer}`);

    let signature: Uint8Array;
    try {
      signature = fromMultibase(p.proofValue as string);
    } catch {
      return fail("signatureInvalid", "proofValue is not base58btc multibase");
    }
    const { proofValue: _pv, ...config } = p;
    const { proof: _proof, ...body } = doc as Record<string, unknown>;
    const hashData = new Uint8Array([...sha256(canonicalBytes(config)), ...sha256(canonicalBytes(body))]);
    try {
      return ed25519VerifyStrict(signature, hashData, key) ? { valid: true } : fail("signatureInvalid", "signature does not verify");
    } catch (e) {
      return fail("signatureInvalid", `verification error: ${String(e)}`);
    }
  }
}

function fail(failure: ProofVerification["failure"], detail: string): ProofVerification {
  return { valid: false, failure, detail };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const DATE_TIME_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A dateTimeStamp with Z or an offset and every field in range, as epoch ms; else undefined. */
function instant(value: string): number | undefined {
  const m = DATE_TIME_STAMP.exec(value);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || s > 59) return undefined;
  if (m[8] !== "Z") {
    const [oh, om] = m[8]!.slice(1).split(":").map(Number) as [number, number];
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return undefined;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * Ed25519 as the library verifier and the Rust, Go and Dart ones check it:
 * RFC 8032 decoding (no ZIP-215), and the cofactorless equation [S]B = R + [k]A.
 */
function ed25519VerifyStrict(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (!ed25519.verify(signature, message, publicKey, { zip215: false })) return false;
  const Point = ed25519.Point;
  const A = Point.fromBytes(publicKey);
  const R = signature.subarray(0, 32);
  const S = le(signature.subarray(32, 64));
  const k = le(sha512(new Uint8Array([...R, ...publicKey, ...message]))) % Point.Fn.ORDER;
  const expected = Point.BASE.multiplyUnsafe(S).subtract(A.multiplyUnsafe(k)).toBytes();
  return equalBytes(expected, R);
}

function le(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}
