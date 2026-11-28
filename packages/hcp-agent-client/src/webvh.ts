// A did:webvh resolver to pass as `resolveDid`: fetches the DID's log and
// VERIFIES it with `didwebvh-ts` (SCID, the entry-hash chain, each entry's
// proof by an authorised update key, and witness proofs when the log names
// witnesses), the same way `@starter/vta-client`'s `verifiedDidWebvh` does. The
// last line is never trusted on its own.
//
// The fetch is injected, so the client never assumes a host or a container:
// the log lives where the DID says (the VTA's own host, or the VTC that hosts
// it). Any other DID method needs its own resolver; compose them in your
// `resolveDid`.

import { ed25519 } from "@noble/curves/ed25519.js";
import { resolveDIDFromLog } from "didwebvh-ts";

import type { DidDocument, ResolveDid } from "./provider.js";

/** Fetches a URL's body as text, or `undefined` when it does not exist (HTTP 404). Throws on anything else. */
export type FetchText = (url: string) => Promise<string | undefined>;

/**
 * Where a did:webvh's files live: `did:webvh:<scid>:<host>[:<path>...]` ->
 * `https://<host>/.well-known/did.jsonl`, or `https://<host>/<path>/did.jsonl`
 * with a path. The host may carry a percent-encoded port. `file` swaps the
 * name, for `did-witness.json`.
 */
export function didWebvhUrl(did: string, file = "did.jsonl"): string {
  const parts = did.split(":");
  if (parts[0] !== "did" || parts[1] !== "webvh" || parts.length < 4 || !parts[2] || !parts[3]) throw new Error(`${did} is not a did:webvh`);
  const host = decodeURIComponent(parts[3]);
  const path = parts.slice(4).map((p) => encodeURIComponent(decodeURIComponent(p)));
  return `https://${host}/${path.length ? `${path.join("/")}/` : ".well-known/"}${file}`;
}

const verifier = { verify: async (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) => ed25519.verify(sig, msg, key) };

/** Resolve a did:webvh from the text of its log (and witness file), verifying the log. Throws when it does not verify. */
export async function resolveDidWebvhLog(did: string, logText: string, witnessText?: string): Promise<DidDocument> {
  const log = logText.trim().split("\n").map((line) => JSON.parse(line));
  const witnessProofs = witnessText === undefined ? undefined : JSON.parse(witnessText);
  const resolved = await resolveDIDFromLog(log, { verifier, requestedDid: did, ...(witnessProofs ? { witnessProofs } : {}) });
  if (resolved.did !== did) throw new Error(`the log resolves to ${resolved.did}, not ${did}`);
  return resolved.doc as unknown as DidDocument;
}

/** A `resolveDid` for did:webvh: fetch the log (and witness file, if there is one) with `fetchText`, then verify it. */
export function didWebvhResolver(fetchText: FetchText): ResolveDid {
  return async (did) => {
    const log = await fetchText(didWebvhUrl(did));
    if (log === undefined) throw new Error(`${did} has no did.jsonl`);
    const witness = await fetchText(didWebvhUrl(did, "did-witness.json"));
    return resolveDidWebvhLog(did, log, witness);
  };
}
