import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyPlan, buildPlan, formatBytes, formatPlan, parseCleanArgs, parseSize, planCache, planCheckout, planForeign, planImages, planSource, planStack, planTars,
  safeToRemove, supersededHint, type CleanArgs, type CleanDeps, type CleanDocker, type CleanFs, type DockerImage, type FsStat, type Git, type Volume,
} from "../lib/clean.js";
import { realCleanFs } from "../lib/clean-real.js";

// --- fakes ------------------------------------------------------------------------------------------------------
const pinned = [{ name: "vta-buildathon", keep: "26d0da81" }, { name: "vtc-buildathon", keep: "26d0da81" }, { name: "mediator-buildathon", keep: "e6e2c636" }];
const img = (repo: string, tag: string, id: string, bytes = 190e6): DockerImage => ({ repo, tag, id, bytes });
const NOW = Date.parse("2026-11-19T12:00:00Z");
const ago = (min: number) => NOW - min * 60_000;

function fakeDocker(o: Partial<{ images: DockerImage[]; running: string[]; builders: { name: string; nodes: string[] }[]; volumes: Volume[]; failRm: string }> = {}) {
  const calls: string[] = [];
  const d: CleanDocker = {
    images: () => o.images ?? [], runningRefs: () => o.running ?? [], builders: () => o.builders ?? [], volumes: () => o.volumes ?? [],
    imageRm: (r) => { calls.push(`image rm ${r}`); return o.failRm === r ? { ok: false, message: "conflict" } : { ok: true }; },
    builderRm: (n) => { calls.push(`buildx rm ${n}`); return { ok: true }; },
    builderPrune: (n) => { calls.push(`buildx prune ${n}`); return { ok: true }; },
  };
  return { d, calls };
}
type Node = Partial<FsStat> & { children?: string[]; size?: number };
function fakeFs(nodes: Record<string, Node>, uid = 1000) {
  const removed: string[] = [];
  const fs: CleanFs = {
    uid,
    list: (dir) => { const n = nodes[dir]; if (!n?.children) throw new Error("ENOENT"); return n.children; },
    stat: (p) => { const n = nodes[p]; return n ? { isDir: false, isFile: false, isSymlink: false, mtimeMs: ago(1000), uid, ...n } : undefined; },
    exists: (p) => p in nodes,
    sizeOf: (p) => nodes[p]?.size ?? 0,
    rm: (p) => { removed.push(p); },
  };
  return { fs, removed };
}
const noGit: Git = () => ({ status: 1, stdout: "" });
const baseArgs: CleanArgs = { scopes: ["images", "cache", "source"], explicit: false, apply: false, yes: false, olderThanMin: 60, includeCheckout: false, pruneCurrent: false, removeCurrent: false };
function deps(over: Partial<CleanDeps> = {}): CleanDeps {
  return { docker: fakeDocker().d, fs: fakeFs({}).fs, git: noGit, now: () => NOW, tmpRoots: ["/var/tmp/x", "/tmp"], cwd: "/work/openvti-starter", home: "/data/u", vtiPath: "/work/verifiable-trust-infrastructure", project: "openvti-starter", pinned, currentBuilder: "buildathon2-m14g-c6", reset: async () => {}, ...over };
}

// --- arguments ----------------------------------------------------------------------------------------------------
test("default scopes are images, cache and source; nothing deletes by default", () => {
  const a = parseCleanArgs([]) as CleanArgs;
  assert.deepEqual(a.scopes, ["images", "cache", "source"]);
  assert.equal(a.apply, false);
  assert.equal(a.explicit, false);
});

test("scopes by --only, --only=, comma lists and bare words; --dry-run is an alias", () => {
  assert.deepEqual((parseCleanArgs(["--only", "cache,images"]) as CleanArgs).scopes, ["images", "cache"]);
  assert.deepEqual((parseCleanArgs(["--only=tars"]) as CleanArgs).scopes, ["tars"]);
  assert.deepEqual((parseCleanArgs(["stack", "--dry-run"]) as CleanArgs).scopes, ["stack"]);
  assert.equal((parseCleanArgs(["--dry-run"]) as CleanArgs).apply, false);
  assert.match((parseCleanArgs(["--dry-run", "--apply"]) as { error: string }).error, /contradict/);
});

test("all is everything but the checkout; the checkout needs --include-checkout", () => {
  assert.deepEqual((parseCleanArgs(["all"]) as CleanArgs).scopes, ["images", "cache", "source", "tars", "stack"]);
  assert.deepEqual((parseCleanArgs(["all", "--include-checkout"]) as CleanArgs).scopes, ["images", "cache", "source", "tars", "stack", "checkout"]);
  assert.match((parseCleanArgs(["checkout"]) as { error: string }).error, /--include-checkout/);
  assert.deepEqual((parseCleanArgs(["checkout", "--include-checkout"]) as CleanArgs).scopes, ["checkout"]);
});

test("bad input is an error, not a guess", () => {
  assert.match((parseCleanArgs(["volumes"]) as { error: string }).error, /unknown scope/);
  assert.match((parseCleanArgs(["--wat"]) as { error: string }).error, /unknown option/);
  assert.match((parseCleanArgs(["--older-than", "x"]) as { error: string }).error, /minutes/);
  assert.equal((parseCleanArgs(["--older-than", "5", "source"]) as CleanArgs).olderThanMin, 5);
  assert.match((parseCleanArgs(["--only"]) as { error: string }).error, /needs a list/);
});

test("sizes parse docker's decimal strings and format back", () => {
  assert.equal(parseSize("196MB"), 196e6);
  assert.equal(parseSize("12.52kB"), 12520);
  assert.equal(parseSize("1.2GB"), 1.2e9);
  assert.equal(parseSize("N/A"), 0);
  assert.equal(formatBytes(12.5e9), "12.5 GB");
  assert.equal(formatBytes(196e6), "196 MB");
});

// --- images -------------------------------------------------------------------------------------------------------
const imgs = [
  img("vta-buildathon", "26d0da81", "A1"), img("vta-buildathon", "local", "A1"),
  img("vta-buildathon", "fc157f76", "B2", 181e6), img("vtc-buildathon", "93d36996", "C3", 196e6),
  img("vtc-buildathon", "26d0da81", "D4"), img("vtc-buildathon", "local", "D4"),
  img("redis", "7.4.6-alpine", "R5"), img("vta-buildathon", "dev", "E6"), img("someone/vta-buildathon-fork", "deadbeef", "F7"),
];

test("images: only <pinned name>:<8 hex> tags that are not the pinned ref are removed; :local, the pinned tag and others stay", () => {
  const p = planImages(imgs, pinned, []);
  assert.deepEqual(p.items.map((i) => i.action), [{ kind: "image-rm", ref: "vta-buildathon:fc157f76" }, { kind: "image-rm", ref: "vtc-buildathon:93d36996" }]);
  assert.equal(p.items.reduce((s, i) => s + i.bytes, 0), 377e6);
});

test("images: a registry-prefixed copy of a pinned image name is recognised, a lookalike name is not", () => {
  const p = planImages([img("ghcr.io/org/vta-buildathon", "fc157f76", "X1"), img("evilvta-buildathon", "fc157f76", "X2")], pinned, []);
  assert.deepEqual(p.items.map((i) => i.action), [{ kind: "image-rm", ref: "ghcr.io/org/vta-buildathon:fc157f76" }]);
});

test("images: an image a running container uses is refused, by name or by (short or full) id", () => {
  const byName = planImages(imgs, pinned, ["vta-buildathon:fc157f76"]);
  assert.equal(byName.items.length, 1);
  assert.match(byName.refused[0].text, /running container/);
  const full = "sha256:" + "c3".padEnd(12, "0") + "ffff";
  const byId = planImages([img("vtc-buildathon", "93d36996", "c30000000000")], pinned, [full]);
  assert.equal(byId.items.length, 0);
  assert.equal(byId.refused.length, 1);
});

test("images: a superseded tag on the same image as a kept tag only untags (frees 0)", () => {
  const p = planImages([img("vta-buildathon", "26d0da81", "S1"), img("vta-buildathon", "11111111", "S1")], pinned, []);
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].bytes, 0);
  assert.match(p.items[0].label, /only untags/);
});

test("images: two superseded tags on one image count its size once", () => {
  const p = planImages([img("vta-buildathon", "11111111", "T1", 100e6), img("vta-buildathon", "22222222", "T1", 100e6)], pinned, []);
  assert.equal(p.items.reduce((s, i) => s + i.bytes, 0), 100e6);
});

test("the post-build hint counts superseded images, and is silent when there are none", () => {
  assert.equal(supersededHint(imgs, pinned, []), "2 superseded images, 377 MB reclaimable: npm run clean -- images");
  assert.equal(supersededHint([img("vta-buildathon", "26d0da81", "A1")], pinned, []), undefined);
});

// --- cache --------------------------------------------------------------------------------------------------------
const builders = [{ name: "buildathon2-m14g-c6", nodes: ["buildathon2-m14g-c60"] }, { name: "buildathon2-m6g-c3", nodes: ["buildathon2-m6g-c30"] }, { name: "other-builder", nodes: ["other-builder0"] }];
const vols: Volume[] = [
  { name: "buildx_buildkit_buildathon2-m14g-c60_state", bytes: 12.5e9 }, { name: "buildx_buildkit_buildathon2-m6g-c30_state", bytes: 3.5e9 }, { name: "buildx_buildkit_other-builder0_state", bytes: 9e9 },
];

test("cache: non-current buildathon2 builders go with their state volume; the current one and other builders stay", () => {
  const p = planCache(builders, vols, "buildathon2-m14g-c6", { pruneCurrent: false, removeCurrent: false });
  assert.deepEqual(p.items.map((i) => [i.action, i.bytes]), [[{ kind: "builder-rm", name: "buildathon2-m6g-c3" }, 3.5e9]]);
  assert.match(p.info[0].text, /kept buildathon2-m14g-c6.*12\.5 GB/);
  assert.match(p.warnings.join(" "), /cold build cache.*25-40 minutes/);
});

test("cache: when the settings' builder does not exist, the most recently used one is kept as current", () => {
  const bs = [{ name: "buildathon2-m14g-c6", nodes: ["buildathon2-m14g-c60"], lastActivity: "2026-11-14T03:53:50Z" }, { name: "buildathon2-m2g-c1", nodes: ["buildathon2-m2g-c10"], lastActivity: "2026-10-01T00:00:00Z" }];
  const p = planCache(bs, [], "buildathon2-m6g-c3", { pruneCurrent: false, removeCurrent: false });
  assert.deepEqual(p.items.map((i) => i.action), [{ kind: "builder-rm", name: "buildathon2-m2g-c1" }]);
  assert.match(p.info.map((l) => l.text).join("\n"), /treating the most recently used builder buildathon2-m14g-c6 as current/);
  const none = planCache(bs, [], undefined, { pruneCurrent: false, removeCurrent: false });
  assert.equal(none.items.length, 1);
});

test("cache: --prune-current prunes, --remove-current removes the current builder", () => {
  const prune = planCache(builders, vols, "buildathon2-m14g-c6", { pruneCurrent: true, removeCurrent: false });
  assert.ok(prune.items.some((i) => i.action.kind === "builder-prune" && i.bytes === 12.5e9));
  const rm = planCache(builders, vols, "buildathon2-m14g-c6", { pruneCurrent: true, removeCurrent: true });
  assert.ok(rm.items.some((i) => i.action.kind === "builder-rm" && (i.action as { name: string }).name === "buildathon2-m14g-c6"));
  assert.ok(!rm.items.some((i) => i.action.kind === "builder-prune"));
});

test("cache: with nothing removable there is no cold-rebuild warning", () => {
  assert.deepEqual(planCache(builders.slice(0, 1), vols, "buildathon2-m14g-c6", { pruneCurrent: false, removeCurrent: false }).warnings, []);
});

// --- source -------------------------------------------------------------------------------------------------------
test("source: old, owned vti-XXXXXX dirs holding Cargo.toml or Dockerfile qualify; everything else is left alone", () => {
  const { fs } = fakeFs({
    "/var/tmp/x": { children: ["vti-aB3dE9", "vti-fresh1", "vti-nofile", "vti-short", "other", "vti-link12", "vti-theirs"] },
    "/var/tmp/x/vti-aB3dE9": { isDir: true, mtimeMs: ago(300), size: 70e6 }, "/var/tmp/x/vti-aB3dE9/Cargo.toml": {},
    "/var/tmp/x/vti-fresh1": { isDir: true, mtimeMs: ago(5) }, "/var/tmp/x/vti-fresh1/Dockerfile": {},
    "/var/tmp/x/vti-nofile": { isDir: true, mtimeMs: ago(500) },
    "/var/tmp/x/vti-short": { isDir: true, mtimeMs: ago(500) }, "/var/tmp/x/vti-short/Cargo.toml": {},
    "/var/tmp/x/other": { isDir: true, mtimeMs: ago(500) }, "/var/tmp/x/other/Cargo.toml": {},
    "/var/tmp/x/vti-link12": { isDir: true, isSymlink: true, mtimeMs: ago(500) }, "/var/tmp/x/vti-link12/Cargo.toml": {},
    "/var/tmp/x/vti-theirs": { isDir: true, mtimeMs: ago(500), uid: 0 }, "/var/tmp/x/vti-theirs/Dockerfile": {},
    "/tmp": { children: ["vti-QwErTy"] }, "/tmp/vti-QwErTy": { isDir: true, mtimeMs: ago(61), size: 70e6 }, "/tmp/vti-QwErTy/Dockerfile": {},
  });
  const p = planSource(["/var/tmp/x", "/tmp", "/missing"], fs, NOW, 60);
  assert.deepEqual(p.items.map((i) => (i.action as { path: string }).path), ["/var/tmp/x/vti-aB3dE9", "/tmp/vti-QwErTy"]);
  assert.equal(p.refused.length, 3);
  assert.match(p.refused.map((r) => r.text).join("\n"), /only 5 min old/);
  assert.match(p.refused.map((r) => r.text).join("\n"), /no Cargo.toml or Dockerfile/);
  assert.match(p.refused.map((r) => r.text).join("\n"), /another user/);
});

test("source: a root listed twice is scanned once", () => {
  const { fs } = fakeFs({ "/tmp": { children: ["vti-QwErTy"] }, "/tmp/vti-QwErTy": { isDir: true, mtimeMs: ago(99) }, "/tmp/vti-QwErTy/Cargo.toml": {} });
  assert.equal(planSource(["/tmp", "/tmp"], fs, NOW, 60).items.length, 1);
});

test("source: against a REAL temp dir (never HOME or the real /tmp): old orphan removed, fresh and look-alike kept", () => {
  const root = mkdtempSync(join(tmpdir(), "clean-test-"));
  const orphan = join(root, "vti-Ab1Cd2"), fresh = join(root, "vti-Zz9Yy8"), notOurs = join(root, "vti-Qq7Ww6"), target = join(root, "precious");
  for (const d of [orphan, fresh, notOurs, target]) mkdirSync(d);
  writeFileSync(join(orphan, "Cargo.toml"), "x"); writeFileSync(join(fresh, "Cargo.toml"), "x"); writeFileSync(join(notOurs, "readme"), "x"); writeFileSync(join(target, "keep"), "x");
  symlinkSync(target, join(root, "vti-Ln1234"));
  const old = new Date(Date.now() - 5 * 3_600_000);
  for (const d of [orphan, notOurs, join(root, "vti-Ln1234")]) utimesSync(d, old, old);
  const plan = planSource([root], realCleanFs, Date.now(), 60);
  assert.deepEqual(plan.items.map((i) => i.action), [{ kind: "rm-dir", path: orphan }]);
  assert.ok(plan.items[0].bytes > 0);
  // Applying removes only the orphan, using the real fs runner, in a temp dir.
  return applyPlan(plan.items, deps({ fs: realCleanFs, tmpRoots: [root] })).then((o) => {
    assert.ok(o[0].ok);
    assert.deepEqual(readdirSync(root).sort(), ["precious", "vti-Ln1234", "vti-Qq7Ww6", "vti-Zz9Yy8"]);
    assert.ok(existsSync(join(target, "keep")));
  });
});

// --- tars ---------------------------------------------------------------------------------------------------------
test("tars: only the default name, in cwd or the given directory/file", () => {
  const { fs } = fakeFs({ "/w": { isDir: true }, "/w/buildathon-images.tar": { isFile: true, size: 430e6 }, "/w/mine.tar": { isFile: true }, "/o": { isDir: true } });
  assert.deepEqual(planTars(undefined, "/w", fs).items.map((i) => [i.action, i.bytes]), [[{ kind: "rm-file", path: "/w/buildathon-images.tar" }, 430e6]]);
  assert.equal(planTars("/w/buildathon-images.tar", "/x", fs).items.length, 1);
  assert.match(planTars("/w/mine.tar", "/x", fs).refused[0].text, /only that name/);
  assert.equal(planTars("/o", "/x", fs).items.length, 0);
  assert.equal(planTars("/nope", "/x", fs).items.length, 0);
});

test("tars: a symlink named like the tar is refused", () => {
  const { fs } = fakeFs({ "/w": { isDir: true }, "/w/buildathon-images.tar": { isFile: true, isSymlink: true } });
  assert.match(planTars(undefined, "/w", fs).refused[0].text, /not a regular file/);
});

// --- stack and foreign volumes --------------------------------------------------------------------------------------
const stackVols: Volume[] = [
  { name: "openvti-starter_vta-data", bytes: 50e6 }, { name: "openvti-starter_vtc-data", bytes: 20e6 },
  { name: "earlier-run_vta-data", bytes: 40e6 }, { name: "other_mediator-data", bytes: 1e6 }, { name: "unrelated_data", bytes: 5e9 },
];

test("stack: only this project's volumes are planned; other checkouts' same-shaped volumes are listed, never removed", () => {
  const { fs } = fakeFs({ "/work/openvti-starter/.vta": { isDir: true, size: 4e3 } });
  const p = planStack(stackVols, "openvti-starter", "/work/openvti-starter", fs);
  assert.equal(p.items.length, 1);
  assert.match(p.items[0].label, /openvti-starter_vta-data, openvti-starter_vtc-data\], \.vta\//);
  assert.equal(p.items[0].bytes, 70e6 + 4e3);
  const f = planForeign(stackVols, "openvti-starter");
  assert.equal(f.items.length, 0);
  assert.deepEqual(f.info.map((l) => l.text.match(/: (\S+) /)![1]), ["earlier-run_vta-data", "other_mediator-data"]);
  assert.match(f.info[0].text, /docker volume rm earlier-run_vta-data/);
});

test("stack: nothing to reset when there are no volumes and no .vta/", () => {
  assert.equal(planStack([], "openvti-starter", "/w", fakeFs({}).fs).items.length, 0);
});

test("stack is only planned when named (the default scopes never include it)", () => {
  const p = buildPlan(baseArgs, deps({ docker: fakeDocker({ volumes: stackVols }).d, fs: fakeFs({ "/work/openvti-starter/.vta": { isDir: true } }).fs }));
  assert.ok(!p.items.some((i) => i.scope === "stack"));
  const q = buildPlan({ ...baseArgs, scopes: ["stack"], explicit: true }, deps({ docker: fakeDocker({ volumes: stackVols }).d, fs: fakeFs({ "/work/openvti-starter/.vta": { isDir: true } }).fs }));
  assert.equal(q.items.filter((i) => i.scope === "stack").length, 1);
});

// --- checkout -----------------------------------------------------------------------------------------------------
const gitOk = (over: Record<string, string> = {}): Git => (_r, a) => {
  const key = a.join(" ");
  if (key in over) return { status: 0, stdout: over[key] };
  return { status: 0, stdout: key === "worktree list --porcelain" ? "worktree /work/verifiable-trust-infrastructure\nHEAD abc\n" : "" };
};
const vti = "/work/verifiable-trust-infrastructure";

test("checkout: a clean single-worktree checkout is planned", () => {
  const { fs } = fakeFs({ [vti]: { size: 900e6 } });
  const p = planCheckout(vti, "/work/openvti-starter", "/data/u", fs, gitOk());
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].bytes, 900e6);
});

test("checkout: refused when dirty, with extra worktrees, with unpushed commits or stashes, or when not a git checkout", () => {
  const { fs } = fakeFs({ [vti]: {} });
  const run = (over: Record<string, string>) => planCheckout(vti, "/work/openvti-starter", "/data/u", fs, gitOk(over));
  assert.match(run({ "status --porcelain": " M a.rs\n" }).refused[0].text, /uncommitted/);
  assert.match(run({ "worktree list --porcelain": "worktree /a\n\nworktree /b\n" }).refused[0].text, /extra git worktrees \(\/b\)/);
  assert.match(run({ "log --branches --not --remotes --oneline": "abc wip\n" }).refused[0].text, /on no remote/);
  assert.match(run({ "stash list": "stash@{0}: x" }).refused[0].text, /stashed/);
  assert.match(planCheckout(vti, "/work/openvti-starter", "/data/u", fs, noGit).refused[0].text, /not a git checkout/);
  for (const p of [run({}), run({ "status --porcelain": "x" })]) assert.ok(p.items.length + p.refused.length === 1);
});

test("checkout: never the root, home, or a directory that contains this project", () => {
  const { fs } = fakeFs({ "/": {}, "/data/u": {}, "/work": {} });
  assert.equal(planCheckout("/", "/work/p", "/data/u", fs, gitOk()).items.length, 0);
  assert.equal(planCheckout("/data/u", "/work/p", "/data/u", fs, gitOk()).items.length, 0);
  assert.equal(planCheckout("/work", "/work/p", "/data/u", fs, gitOk()).items.length, 0);
});

test("checkout: a missing directory is just noted", () => {
  const p = planCheckout(vti, "/w", "/data/u", fakeFs({}).fs, gitOk());
  assert.equal(p.items.length, 0);
  assert.match(p.info[0].text, /not there/);
});

// --- plan text and apply ------------------------------------------------------------------------------------------
test("the plan prints every item with its size, a total per scope and a grand total", () => {
  const { d } = fakeDocker({ images: imgs, builders, volumes: vols });
  const plan = buildPlan(baseArgs, deps({ docker: d }));
  const text = formatPlan(plan, baseArgs.scopes);
  assert.match(text, /== images\n.*190 MB|== images\n.*181 MB/);
  assert.match(text, /image vta-buildathon:fc157f76/);
  assert.match(text, /images reclaimable: 377 MB/);
  assert.match(text, /cache reclaimable: 3\.5 GB/);
  assert.match(text, /source reclaimable: 0 B/);
  assert.match(text, /total reclaimable: 3\.9 GB in 3 items/);
  assert.match(text, /warning: The next image build starts with a cold build cache/);
});

test("a docker that cannot be read is a warning in the plan, not a crash", () => {
  const d = fakeDocker().d;
  d.images = () => { throw new Error("Cannot connect to the Docker daemon"); };
  const plan = buildPlan(baseArgs, deps({ docker: d }));
  assert.match(plan.warnings[0], /could not read images.*Docker daemon/);
});

test("apply removes one image tag at a time and keeps going after a failure", async () => {
  const { d, calls } = fakeDocker({ images: imgs, failRm: "vta-buildathon:fc157f76" });
  const plan = buildPlan({ ...baseArgs, scopes: ["images"] }, deps({ docker: d }));
  const out = await applyPlan(plan.items, deps({ docker: d }));
  assert.deepEqual(calls, ["image rm vta-buildathon:fc157f76", "image rm vtc-buildathon:93d36996"]);
  assert.deepEqual(out.map((o) => o.ok), [false, true]);
  assert.equal(out[0].message, "conflict");
});

test("apply order: stack first, checkout last", async () => {
  const order: string[] = [];
  const { d } = fakeDocker();
  const items = [
    { scope: "checkout" as const, label: "c", bytes: 0, action: { kind: "checkout-rm" as const, path: vti } },
    { scope: "images" as const, label: "i", bytes: 0, action: { kind: "image-rm" as const, ref: "vta-buildathon:11111111" } },
    { scope: "stack" as const, label: "s", bytes: 0, action: { kind: "stack-reset" as const } },
  ];
  const f = fakeFs({});
  await applyPlan(items, deps({ docker: { ...d, imageRm: (r) => { order.push(r); return { ok: true }; } }, fs: { ...f.fs, rm: (p) => { order.push(p); } }, reset: async () => { order.push("reset"); } }));
  assert.deepEqual(order, ["reset", "vta-buildathon:11111111", vti]);
});

test("apply refuses to delete anything that does not look like ours, even if a plan says so", () => {
  const d = deps();
  assert.match(safeToRemove({ kind: "rm-dir", path: "/data/u/Documents" }, d)!, /name pattern/);
  assert.match(safeToRemove({ kind: "rm-dir", path: "/etc/vti-abcdef" }, d)!, /not directly inside a temp/);
  assert.match(safeToRemove({ kind: "rm-file", path: "/w/notes.tar" }, d)!, /not named/);
  assert.match(safeToRemove({ kind: "checkout-rm", path: "/data/u" }, d)!, /not a deletable/);
  assert.equal(safeToRemove({ kind: "rm-dir", path: "/tmp/vti-abcdef" }, deps({ fs: fakeFs({ "/tmp/vti-abcdef": {} }).fs })), undefined);
});

test("applyPlan reports a refused deletion as a failure without touching the fs", async () => {
  const f = fakeFs({});
  const out = await applyPlan([{ scope: "source", label: "x", bytes: 0, action: { kind: "rm-dir", path: "/data/u/Documents" } }], deps({ fs: f.fs }));
  assert.equal(out[0].ok, false);
  assert.deepEqual(f.removed, []);
});
