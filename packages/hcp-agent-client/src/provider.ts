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
  verificationMethod?: { id: string; type: string; publicKeyMultibase?: string }[];
  authentication?: (string | { id: string })[];
  keyAgreement?: (string | { id: string })[];
  service?: { id?: string; type: string | string[]; serviceEndpoint: unknown }[];
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
