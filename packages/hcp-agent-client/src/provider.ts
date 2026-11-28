// Finding the provider: the person's VTA, wherever it runs (its own service,
// or one a community hosts for its members). The client never assumes a
// container, host or URL. It takes the VTA's DID from the pairing, resolves
// it, and reads the keys and the TSP route from the DID document.
//
// Resolution is a seam: pass any `resolveDid` (a did:webvh resolver, a cache,
// a fixed document in tests). This module only reads the document.

import { base58 } from "@scure/base";

import type { PeerKeys } from "./identity.js";

/** The parts of a DID document this module reads. */
export interface DidDocument {
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  capabilityInvocation?: (string | VerificationMethod)[];
  capabilityDelegation?: (string | VerificationMethod)[];
  keyAgreement?: (string | VerificationMethod)[];
  service?: { id?: string; type: string | string[]; serviceEndpoint: unknown }[];
}

/** A verification method: listed in `verificationMethod`, or embedded in a relationship. */
export interface VerificationMethod {
  id: string;
  type?: string;
  controller?: string;
  publicKeyMultibase?: string;
}

/** Resolves a DID to its document. */
export type ResolveDid = (did: string) => Promise<DidDocument>;

/** The provider as the client needs it: keys, and where messages to it go. */
export interface ProviderEndpoint {
  keys: PeerKeys;
  /** The `serviceEndpoint` of the provider's `TSPTransport` service: a mediator DID or a URL, as the document says. */
  tspEndpoint?: unknown;
}

const ED25519_PUB = [0xed, 0x01];
const X25519_PUB = [0xec, 0x01];

function keyBytes(multibase: string, codec: number[]): Uint8Array | undefined {
  if (!multibase.startsWith("z")) return undefined;
  const raw = base58.decode(multibase.slice(1));
  if (raw.length !== 34 || raw[0] !== codec[0] || raw[1] !== codec[1]) return undefined;
  return raw.slice(2);
}

function methodFor(doc: DidDocument, refs: (string | { id: string })[] | undefined, codec: number[]): Uint8Array | undefined {
  for (const ref of refs ?? []) {
    const id = typeof ref === "string" ? ref : ref.id;
    const full = id.startsWith("#") ? `${doc.id}${id}` : id;
    const vm = doc.verificationMethod?.find((m) => m.id === full || m.id === id || `${doc.id}${m.id}` === full);
    const bytes = vm?.publicKeyMultibase ? keyBytes(vm.publicKeyMultibase, codec) : undefined;
    if (bytes !== undefined) return bytes;
  }
  return undefined;
}

/** The signing relationships a proof may name; `keyAgreement` never signs. */
const SIGNING_RELATIONSHIPS = ["authentication", "assertionMethod", "capabilityInvocation", "capabilityDelegation"] as const;

/**
 * The Ed25519 public key of verification method `vmId`, only when `doc` lists
 * it under `purpose` (by reference, a relative `#id`, or embedded), its
 * `controller` is the document's DID, and it is an Ed25519 multikey. Else
 * undefined. A proof's key must pass this before its signature counts.
 */
export function ed25519KeyOf(doc: DidDocument, vmId: string, purpose: string): Uint8Array | undefined {
  if (!(SIGNING_RELATIONSHIPS as readonly string[]).includes(purpose)) return undefined;
  const abs = (id: string) => (id.startsWith("#") ? `${doc.id}${id}` : id);
  const want = abs(vmId);
  const refs = (doc as unknown as Record<string, (string | VerificationMethod)[] | undefined>)[purpose] ?? [];
  const ref = refs.find((r) => abs(typeof r === "string" ? r : r.id) === want);
  if (ref === undefined) return undefined;
  const vm = typeof ref === "string" ? doc.verificationMethod?.find((m) => abs(m.id) === want) : ref;
  if (vm === undefined || vm.controller !== doc.id || vm.publicKeyMultibase === undefined) return undefined;
  if (vm.type !== undefined && vm.type !== "Multikey" && vm.type !== "Ed25519VerificationKey2020") return undefined;
  return keyBytes(vm.publicKeyMultibase, ED25519_PUB);
}

/**
 * The provider's keys and TSP route from its DID document: the Ed25519
 * `authentication` key, the X25519 `keyAgreement` key, and the `TSPTransport`
 * service. Throws when a key is missing.
 */
export function providerFromDidDocument(doc: DidDocument): ProviderEndpoint {
  const signingKey = methodFor(doc, doc.authentication, ED25519_PUB);
  const encryptionKey = methodFor(doc, doc.keyAgreement, X25519_PUB);
  if (signingKey === undefined) throw new Error(`${doc.id} has no Ed25519 authentication key`);
  if (encryptionKey === undefined) throw new Error(`${doc.id} has no X25519 keyAgreement key`);
  const tsp = doc.service?.find((s) => (Array.isArray(s.type) ? s.type : [s.type]).includes("TSPTransport"));
  return { keys: { vid: doc.id, signingKey, encryptionKey }, tspEndpoint: tsp?.serviceEndpoint };
}

/** Resolve the provider named by `vtaDid` (from the pairing) through `resolveDid`. */
export async function resolveProvider(vtaDid: string, resolveDid: ResolveDid): Promise<ProviderEndpoint> {
  const doc = await resolveDid(vtaDid);
  if (doc.id !== vtaDid) throw new Error(`resolved ${doc.id}, not ${vtaDid}`);
  return providerFromDidDocument(doc);
}
