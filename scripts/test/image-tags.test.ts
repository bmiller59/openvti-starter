import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalTags, isRefTag, localRefs, refShort, tagPulled, tagVerified, versionTag, type PullTagger } from "../lib/image-tags.js";
import { imageSpecs } from "../lib/images.js";
import { pinnedImages } from "../lib/clean.js";
import { pins } from "../pins.js";

const specs = imageSpecs(pins());
const D = "sha256:" + "b".repeat(64);

test("tags derive from pins.json: <ref8> and <version>-<ref8>", () => {
  const p = pins();
  assert.deepEqual(canonicalTags(specs.vta), [refShort(p.vti.vta.ref), `${p.vti.vta.version}-${p.vti.vta.ref.slice(0, 8)}`]);
  assert.equal(versionTag("0.72.0", "26d0da81a1ae2df800ee6b9c1806bb3c3c7a9d2f"), "0.72.0-26d0da81");
  assert.equal(versionTag("0.48.0", "e6e2c63654bb43bb7feb732834702cd940b2bcce"), "0.48.0-e6e2c636");
});

test("localRefs adds :local for builds only, and never latest", () => {
  const s = { name: "vta-buildathon", version: "0.72.0", ref: "26d0da81a1ae" };
  assert.deepEqual(localRefs(s), ["vta-buildathon:26d0da81", "vta-buildathon:0.72.0-26d0da81"]);
  assert.deepEqual(localRefs(s, { local: true }), ["vta-buildathon:26d0da81", "vta-buildathon:0.72.0-26d0da81", "vta-buildathon:local"]);
  assert.ok(!localRefs(s, { local: true }).some((r) => r.endsWith(":latest")));
});

test("isRefTag accepts both forms and rejects look-alikes", () => {
  for (const t of ["26d0da81", "0.72.0-26d0da81"]) assert.ok(isRefTag(t), t);
  for (const t of ["local", "latest", "dev", "0.72.0", "0.72.0-xyz", "26d0da8", "0.65.0-rc1"]) assert.ok(!isRefTag(t), t);
});

test("clean keeps exactly the tags images use", () => {
  assert.deepEqual(pinnedImages(pins()).map((x) => x.keep), IMAGE_ORDER.map((k) => canonicalTags(specs[k])));
});
const IMAGE_ORDER = ["vta", "vtc", "mediator"] as const;

const fake = (o: { digests?: string[]; failOn?: string } = {}) => {
  const calls: string[] = [];
  const d: PullTagger = {
    repoDigests: () => o.digests ?? [],
    tag: (s, t) => { calls.push(`${s} -> ${t}`); return o.failOn === t ? { ok: false, stderr: "boom\n" } : { ok: true, stderr: "" }; },
  };
  return { d, calls };
};
const spec = (digest: string | null) => ({ ...specs.mediator, digest });

test("tagPulled tags both forms and stops at the first failure", () => {
  const a = fake();
  const r = tagPulled(specs.mediator, "src", a.d);
  assert.deepEqual(r, { ok: true, tagged: ["mediator-buildathon:e6e2c636", "mediator-buildathon:0.48.0-e6e2c636"] });
  const b = fake({ failOn: "mediator-buildathon:0.48.0-e6e2c636" });
  const f = tagPulled(specs.mediator, "src", b.d);
  assert.equal(f.ok, false);
  assert.match((f as { message: string }).message, /could not tag src as mediator-buildathon:0\.48\.0-e6e2c636: boom/);
});

test("tagVerified tags only when the pinned digest is reported, never :local", () => {
  const s = spec(D);
  const ok = fake({ digests: [`${s.repo}@${D}`] });
  const r = tagVerified(s, s.pinned, ok.d);
  assert.equal(r.ok, true);
  assert.equal(ok.calls.length, 2);
  assert.ok(ok.calls.every((c) => !c.endsWith(":local")));
  const bad = fake({ digests: [`${s.repo}@sha256:${"c".repeat(64)}`] });
  const rb = tagVerified(s, s.pinned, bad.d);
  assert.equal(rb.ok, false);
  assert.equal(bad.calls.length, 0);
});

test("tagVerified leaves an unpinned (tag-only) pull untagged", () => {
  const f = fake({ digests: ["x"] });
  const r = tagVerified(spec(null), "ref", f.d);
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 0);
  assert.match(r.message ?? "", /no pinned digest/);
});
