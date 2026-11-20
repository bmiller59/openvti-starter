import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTagConflicts, checkTagMove, containersUsing, imageId, type DockerQuery } from "../lib/image-guard.js";
import { tagPulled, tagVerified, type PullTagger } from "../lib/image-tags.js";
import { imageSpecs } from "../lib/images.js";
import { pins } from "../pins.js";

// A fake Docker: tags map to image ids; containers say which image id they run. Only read-only queries are answered.
function fakeQuery(tags: Record<string, string>, containers: { name: string; project?: string; image: string; running?: boolean }[] = []) {
  const calls: string[][] = [];
  const q: DockerQuery = {
    run: (args) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "inspect") { const id = tags[args[2]!]; return id ? { status: 0, stdout: id + "\n" } : { status: 1, stdout: "", stderr: "Error: No such image: " + args[2] }; }
      if (args[0] === "ps") {
        const id = args.find((a) => a.startsWith("ancestor="))!.slice(9);
        return { status: 0, stdout: containers.filter((c) => c.image === id).map((c) => `${c.name}\t${c.project ?? ""}`).join("\n") };
      }
      return { status: 1, stdout: "" };
    },
  };
  return { q, calls };
}
const specs = imageSpecs(pins());
const spec = specs.vta;
const OLD = "sha256:" + "1".repeat(64), NEW = "sha256:" + "2".repeat(64);
const refs = [`${spec.name}:${spec.ref.slice(0, 8)}`, `${spec.name}:${spec.version}-${spec.ref.slice(0, 8)}`];

function tagger(q: DockerQuery, force = false) {
  const tagCalls: string[] = [];
  const t: PullTagger = { query: q, force, repoDigests: () => [`${spec.repo}@sha256:${"b".repeat(64)}`], tag: (s, d) => { tagCalls.push(`${s} -> ${d}`); return { ok: true, stderr: "" }; } };
  return { t, tagCalls };
}

test("imageId and containersUsing only run read-only docker queries (image inspect, ps -a)", () => {
  const { q, calls } = fakeQuery({ x: OLD }, [{ name: "a-vta-1", project: "a", image: OLD }]);
  assert.equal(imageId(q, "x"), OLD);
  assert.equal(imageId(q, "nope"), undefined);
  const down: DockerQuery = { run: () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }) };
  assert.throws(() => imageId(down, "x"), /could not inspect/);
  assert.equal(checkTagMove(down, "x", NEW).move, false); // daemon down on inspect: fail closed, not "new"
  const timeout: DockerQuery = { run: () => ({ status: null, stdout: "" }) };
  assert.equal(checkTagMove(timeout, "x", NEW).move, false);
  assert.deepEqual(containersUsing(q, OLD), [{ name: "a-vta-1", project: "a" }]);
  for (const c of calls) assert.ok((c[0] === "image" && c[1] === "inspect") || (c[0] === "ps" && c.includes("-a")), c.join(" "));
});

test("checkTagMove: absent and unused tags move; the same image is always fine; any container (stopped too) blocks", () => {
  const { q } = fakeQuery({ t1: OLD, t2: OLD }, [{ name: "bamvtilive-vta-1", project: "bamvtilive", image: OLD }]);
  assert.deepEqual(checkTagMove(q, "missing", NEW), { move: true, why: "new" });
  assert.deepEqual(checkTagMove(q, "t1", OLD), { move: false, why: "same" });
  const c = checkTagMove(q, "t1", NEW);
  assert.equal(c.move, false);
  assert.deepEqual((c as { users: unknown[] }).users, [{ name: "bamvtilive-vta-1", project: "bamvtilive" }]);
  const free = fakeQuery({ t1: OLD });
  assert.deepEqual(checkTagMove(free.q, "t1", NEW), { move: true, why: "unused" });
});

test("checkTagMove fails safe when docker ps cannot be read", () => {
  const q: DockerQuery = { run: (a) => (a[0] === "image" ? { status: 0, stdout: OLD } : { status: 1, stdout: "" }) };
  assert.equal(checkTagMove(q, "t", NEW).move, false);
});

test("tagPulled leaves tags used by any container alone, reports who, and still tags the rest", () => {
  const { q } = fakeQuery({ [refs[0]!]: OLD, [refs[1]!]: OLD, src: NEW }, [{ name: "bamvtilive-vta-1", project: "bamvtilive", image: OLD }]);
  const { t, tagCalls } = tagger(q);
  const r = tagPulled(spec, "src", t);
  assert.equal(r.ok, true);
  assert.deepEqual(tagCalls, []);
  const skipped = (r as { skipped: string[] }).skipped;
  assert.equal(skipped.length, 2);
  assert.match(skipped[0]!, /bamvtilive-vta-1 \(compose project bamvtilive\)/);
  assert.match(skipped[0]!, /version-ref tag/);
  assert.match(skipped[0]!, /--force/);
});

test("a stopped container counts the same as a running one", () => {
  const { q } = fakeQuery({ [refs[0]!]: OLD, src: NEW }, [{ name: "old-stopped", project: "", image: OLD, running: false }]);
  const { t, tagCalls } = tagger(q);
  const r = tagPulled(spec, "src", t) as { skipped: string[] };
  assert.equal(tagCalls.length, 1); // only the absent version-ref tag moved
  assert.match(r.skipped[0]!, /old-stopped \(not a compose project\)/);
});

test("re-tagging a tag that already points at the pulled image is idempotent, even when containers use it", () => {
  const { q } = fakeQuery({ [refs[0]!]: NEW, [refs[1]!]: NEW, src: NEW }, [{ name: "c", image: NEW }]);
  const { t, tagCalls } = tagger(q);
  const r = tagPulled(spec, "src", t) as { tagged: string[]; skipped: string[] };
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.tagged, refs);
  assert.deepEqual(tagCalls, []);
});

test("unused existing tags are moved, and force moves used ones", () => {
  const free = fakeQuery({ [refs[0]!]: OLD, [refs[1]!]: OLD, src: NEW });
  assert.equal(tagger(free.q).tagCalls.length, 0);
  const a = tagger(free.q);
  tagPulled(spec, "src", a.t);
  assert.equal(a.tagCalls.length, 2);
  const used = fakeQuery({ [refs[0]!]: OLD, [refs[1]!]: OLD, src: NEW }, [{ name: "c", image: OLD }]);
  const f = tagger(used.q, true);
  tagPulled(spec, "src", f.t);
  assert.equal(f.tagCalls.length, 2);
});

test("tagVerified: a skipped tag is a result, not a failure (the digest reference is what up and verify use)", () => {
  const D = "sha256:" + "b".repeat(64);
  const s = { ...spec, digest: D };
  const { q } = fakeQuery({ [refs[0]!]: OLD, [refs[1]!]: OLD, src: NEW }, [{ name: "bamvtilive-vta-1", project: "bamvtilive", image: OLD }]);
  const { t, tagCalls } = tagger(q);
  const r = tagVerified(s, "src", { ...t, repoDigests: () => [`${s.repo}@${D}`] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tagged, []);
  assert.equal(r.skipped?.length, 2);
  assert.deepEqual(tagCalls, []);
});

test("images:build preflight lists in-use tags and ignores free or absent ones", () => {
  const { q } = fakeQuery({ "n:local": OLD, "n:free": NEW }, [{ name: "x-vta-1", project: "x", image: OLD }]);
  const c = buildTagConflicts(q, ["n:local", "n:free", "n:absent"]);
  assert.equal(c.length, 1);
  assert.match(c[0]!, /n:local is used by x-vta-1 \(compose project x\).*--force/);
});
