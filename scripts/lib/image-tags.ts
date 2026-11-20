// The canonical local tags of an image (docs/IMAGES.md, "Image names and tags"). One place, so images:build, images:pull and
// `npm run clean` agree. Pure apart from `tagPulled`, which takes a fake-able `Tagger`.
//   <ref8>            first 8 characters of the pinned upstream ref
//   <version>-<ref8>  the pinned version plus that, e.g. 0.72.0-26d0da81
//   :local            only for a local build (images:build); a pulled image never gets it
// There is deliberately no floating `latest`: a moving tag defeats pinning. The digest in pins.json is the verified reference.
import { spawnSync } from "node:child_process";
import type { ImageKind, ImageSpec } from "./images.js";

export const refShort = (ref: string): string => ref.slice(0, 8);

/** `<version>-<ref8>`. */
export const versionTag = (version: string, ref: string): string => `${version}-${refShort(ref)}`;

/** The tags every copy of the pinned image carries, built or pulled: [`<ref8>`, `<version>-<ref8>`]. */
export const canonicalTags = (spec: Pick<ImageSpec, "version" | "ref">): string[] => [refShort(spec.ref), versionTag(spec.version, spec.ref)];

/** `<name>:<tag>` references for a local copy; `local` adds `<name>:local` (builds only). */
export function localRefs(spec: Pick<ImageSpec, "name" | "version" | "ref">, o: { local?: boolean } = {}): string[] {
  const refs = canonicalTags(spec).map((t) => `${spec.name}:${t}`);
  return o.local ? [...refs, `${spec.name}:local`] : refs;
}

/** Does a tag look like one of ours (`<ref8>` or `<version>-<ref8>`), pinned or not? Used to find superseded images. */
export const isRefTag = (tag: string): boolean => /^(?:[0-9][0-9A-Za-z.+_]*-)?[0-9a-f]{8}$/.test(tag);

export interface Tagger { tag(src: string, dst: string): { ok: boolean; stderr: string } }

/**
 * Give an already pulled (and, where a digest is pinned, digest-checked) image its canonical local tags.
 * Idempotent: `docker tag` re-pointing a canonical tag at the pinned image is the intent, so nothing is skipped. Returns
 * the refs that were tagged, or the first error.
 */
export function tagPulled(spec: Pick<ImageSpec, "name" | "version" | "ref" | "kind">, source: string, d: Tagger): { ok: true; tagged: string[] } | { ok: false; kind: ImageKind; message: string } {
  const tagged: string[] = [];
  for (const dst of localRefs(spec)) {
    const r = d.tag(source, dst);
    if (!r.ok) return { ok: false, kind: spec.kind, message: `could not tag ${source} as ${dst}: ${r.stderr.trim()}` };
    tagged.push(dst);
  }
  return { ok: true, tagged };
}

export interface PullTagger extends Tagger { repoDigests(ref: string): string[] }

/**
 * images:pull's tagging step: a digest-pinned image is tagged only when it reports exactly the pinned digest, and an
 * unpinned (tag-only, unverified) pull is not tagged at all, so nothing unverified looks like the pin. Never tags :local.
 */
export function tagVerified(spec: Pick<ImageSpec, "name" | "version" | "ref" | "kind" | "repo" | "digest">, ref: string, d: PullTagger): { ok: boolean; tagged: string[]; message?: string } {
  if (!spec.digest) return { ok: true, tagged: [], message: "not tagged locally (no pinned digest to verify against)" };
  if (!d.repoDigests(ref).includes(`${spec.repo}@${spec.digest}`)) return { ok: false, tagged: [], message: `${ref} does not report the pinned digest; not tagging it` };
  const t = tagPulled(spec, ref, d);
  return t.ok ? { ok: true, tagged: t.tagged } : { ok: false, tagged: [], message: t.message };
}

export const realTagger: PullTagger = {
  repoDigests: (ref) => spawnSync("docker", ["image", "inspect", ref, "--format", "{{range .RepoDigests}}{{println .}}{{end}}"], { encoding: "utf8", timeout: 30_000 }).stdout.trim().split("\n"),
  tag: (src, dst) => {
    const r = spawnSync("docker", ["tag", src, dst], { encoding: "utf8", timeout: 30_000 });
    return { ok: r.status === 0, stderr: r.stderr ?? "" };
  },
};
