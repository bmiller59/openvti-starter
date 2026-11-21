// The CI pin gate: the pull-vs-build decision and the gate steps (pure, injected runner, no Docker, no network), and static
// checks of .github/workflows/pins-gate.yml. This does NOT prove the workflow works on GitHub; only a real run does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { cooldownStep, DEFAULT_COOLDOWN_SECS, gateSteps, parseCooldown, parseImagesChoice, pullBlockers, resolveImagesSource, runGate, verifiedLogLine } from "../lib/pins-verify.js";
import type { Pins } from "../pins.js";

const real = () => JSON.parse(readFileSync(new URL("../../pins.json", import.meta.url), "utf8")) as Pins;
const D = "sha256:" + "a".repeat(64);
const published = (): Pins => { const p = real(); p.images.available = true; p.images.vta.digest = D; p.images.vtc.digest = D; return p; };

test("parseImagesChoice: default build, both spellings, rejects anything else", () => {
  assert.deepEqual(parseImagesChoice([]), { choice: "build" });
  assert.deepEqual(parseImagesChoice(["--images", "pull"]), { choice: "pull" });
  assert.deepEqual(parseImagesChoice(["--plan", "--images=auto"]), { choice: "auto" });
  assert.ok("error" in parseImagesChoice(["--images", "cache"]));
  assert.ok("error" in parseImagesChoice(["--images"]));
});

test("resolveImagesSource: auto pulls only when pins.json says the images are available", () => {
  const p = real();
  p.images.available = false;
  assert.equal(resolveImagesSource(p, "auto").source, "build");
  assert.match(resolveImagesSource(p, "auto").reason, /available is false/);
  p.images.available = true;
  assert.equal(resolveImagesSource(p, "auto").source, "pull");
  assert.equal(resolveImagesSource(p, "build").source, "build");
  p.images.available = false;
  assert.equal(resolveImagesSource(p, "pull").source, "pull");
});

test("pullBlockers: fails closed when the VTA or VTC digest is not pinned (the mediator is not part of the gate)", () => {
  assert.deepEqual(pullBlockers(published()), []);
  const p = published();
  p.images.vtc.digest = null;
  p.images.mediator.digest = null;
  assert.equal(pullBlockers(p).length, 1);
  assert.match(pullBlockers(p)[0]!, /images\.vtc\.digest is null/);
});

test("gateSteps: build mode is unchanged; pull mode pulls by digest, verifies, then runs the same gate against the registry images", () => {
  assert.deepEqual(gateSteps().map((s) => s.name), ["images:build", "up", "e2e", "cooldown", "test:roles", "hello"]);
  assert.deepEqual(gateSteps({ images: "build" }), gateSteps());
  const steps = gateSteps({ images: "pull" });
  assert.deepEqual(steps.map((s) => s.name), ["pull:vta", "pull:vtc", "verify:vta", "verify:vtc", "up", "e2e", "cooldown", "test:roles", "hello"]);
  assert.ok(steps.every((s) => s.timeoutMs > 0));
  assert.ok(steps.filter((s) => s.name !== "cooldown").every((s) => s.env?.IMAGES === "registry"), "every step uses the registry images, never a stale local build");
  assert.equal(steps.find((s) => s.name === "up")!.env?.WITH_VTC, "1");
  assert.ok(steps.filter((s) => s.name.startsWith("pull:")).every((s) => s.args.includes("--by-digest")));
  assert.ok(!steps.some((s) => s.args.includes("images:build")));
  // The shared tail is the same list in both modes: nothing is duplicated in the workflow.
  assert.deepEqual(steps.slice(4).map((s) => s.args.join(" ")), gateSteps().slice(1).map((s) => s.args.join(" ")));
});

test("gate plan: a bounded cool-down sits between e2e and test:roles (the VTC's admission budget refills), configurable, 0 removes it", () => {
  const names = (o?: { cooldownSecs?: number }) => gateSteps({ images: "pull", ...o }).map((s) => s.name);
  const n = names();
  assert.equal(n[n.indexOf("e2e") + 1], "cooldown");
  assert.equal(n[n.indexOf("cooldown") + 1], "test:roles");
  const c = gateSteps().find((s) => s.name === "cooldown")!;
  assert.deepEqual([c.cmd, c.args], ["sleep", [String(DEFAULT_COOLDOWN_SECS)]]);
  assert.ok(DEFAULT_COOLDOWN_SECS >= 50, "at least the unauth bucket's full refill (burst 10, one per 5 s)");
  assert.ok(c.timeoutMs > DEFAULT_COOLDOWN_SECS * 1000 && c.timeoutMs < 5 * 60_000, "bounded");
  assert.deepEqual(gateSteps({ cooldownSecs: 90 }).find((s) => s.name === "cooldown")!.args, ["90"]);
  assert.equal(cooldownStep(5).timeoutMs, 35_000);
  assert.ok(!names({ cooldownSecs: 0 }).includes("cooldown"));
});

test("parseCooldown: flag beats env beats default; rejects junk and out-of-range", () => {
  assert.deepEqual(parseCooldown([]), { secs: DEFAULT_COOLDOWN_SECS });
  assert.deepEqual(parseCooldown([], { PINS_COOLDOWN_SECS: "75" }), { secs: 75 });
  assert.deepEqual(parseCooldown(["--cooldown", "10"], { PINS_COOLDOWN_SECS: "75" }), { secs: 10 });
  assert.deepEqual(parseCooldown(["--cooldown=0"]), { secs: 0 });
  for (const bad of ["-1", "abc", "1.5", "601"]) assert.ok("error" in parseCooldown(["--cooldown", bad]), bad);
  assert.ok("error" in parseCooldown(["--cooldown"]));
});

test("pull mode stops at a failed verification before the stack starts", () => {
  const ran: string[] = [];
  const r = runGate(gateSteps({ images: "pull" }), (s) => { ran.push(s.name); return { status: s.name === "verify:vtc" ? 2 : 0, timedOut: false }; });
  assert.equal(r.passed, false);
  assert.deepEqual(ran, ["pull:vta", "pull:vtc", "verify:vta", "verify:vtc"]);
});

test("verifiedLogLine names the image source that was actually used", () => {
  assert.match(verifiedLogLine(real(), "2030-01-02"), /images:build, WITH_VTC=1 up/);
  assert.match(verifiedLogLine(real(), "2030-01-02", "pull"), /images:pull by digest, images:verify, WITH_VTC=1 up/);
});

// --- the workflow file ---------------------------------------------------------------------------------------------
const raw = readFileSync(new URL("../../.github/workflows/pins-gate.yml", import.meta.url), "utf8");
const code = raw.replace(/^\s*#.*$/gm, "");
type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; needs?: unknown; permissions?: Record<string, string>; "timeout-minutes"?: number; steps: Step[] };
const wf = parse(raw) as { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: { group: string; "cancel-in-progress": boolean }; jobs: Record<string, Job> };

test("pins-gate workflow: PRs and manual runs, no trigger path filter (a skipped required check would block merges)", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.equal(wf.on.pull_request, null, "no paths/branches filter on the trigger");
  assert.ok(!/pull_request_target/.test(code));
  assert.deepEqual(Object.keys(wf.jobs), ["changes", "gate", "pins-gate"]);
  assert.equal(wf.jobs["pins-gate"]!.name, "pins-gate");
  assert.equal(wf.jobs["pins-gate"]!.if, "always()");
});

test("pins-gate workflow: the change filter covers the agreed paths and matches them", () => {
  const run = wf.jobs.changes!.steps.map((s) => s.run ?? "").join("\n");
  const re = new RegExp(/grep -Eq '([^']+)'/.exec(run)![1]!);
  for (const f of ["pins.json", "docker-compose.yml", "docker/vtc.Dockerfile", "docker/x/y", "scripts/pins-verify.ts", "scripts/lib/pins-update.ts", ".github/workflows/pins-gate.yml"]) assert.match(f, re, f);
  for (const f of ["README.md", "scripts/images.ts", "scripts/test/pins-gate.test.ts", "scripts/lib/images.ts", "pins.json.bak", "mydocker/x", ".github/workflows/ci.yml"]) assert.doesNotMatch(f, re, f);
});

test("pins-gate workflow: least privilege, bounded, superseded runs cancelled", () => {
  assert.deepEqual(wf.permissions, { contents: "read" });
  assert.deepEqual(wf.jobs.gate!.permissions, { contents: "read", packages: "read" });
  assert.ok(!/id-token|write-all|:\s*write/.test(code), "verification is public (gh attestation, cosign), it needs no OIDC token and nothing writes");
  for (const [n, j] of Object.entries(wf.jobs)) assert.ok(typeof j["timeout-minutes"] === "number", `${n} has a timeout`);
  assert.equal(wf.concurrency["cancel-in-progress"], true);
  assert.match(wf.concurrency.group, /^pins-gate-/);
  assert.equal([...code.matchAll(/runs-on:\s*(\S+)/g)].every((m) => m[1] === "ubuntu-24.04"), true);
});

test("pins-gate workflow: every action is pinned to a full commit SHA with a version comment", () => {
  const uses = [...code.matchAll(/uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 5);
  for (const [, ref, rest] of uses) { assert.match(ref!, /@[0-9a-f]{40}$/, ref); assert.match(rest!, /#\s*v\d/, `${ref} needs a version comment`); }
});

test("pins-gate workflow: delegates to pins:verify (no copy of the gate commands), Node as ci.yml, always tears down", () => {
  assert.ok(/pins:verify -- --images "\$SOURCE"/.test(code));
  assert.ok(!/npm run (e2e|test:roles|hello|up|images:build)\b/.test(code), "the step list lives in scripts/lib/pins-verify.ts");
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.equal(/node-version:\s*(\S+)/.exec(raw)![1], /node-version:\s*(\S+)/.exec(ci)![1]);
  const down = wf.jobs.gate!.steps.find((s) => s.run === "npm run down")!;
  assert.equal(down.if, "always()");
  const upload = wf.jobs.gate!.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
  assert.match(upload.if!, /failure\(\)/);
});

test("pins-gate workflow: pull-only steps are conditional on the source, and the build checkout needs no secret", () => {
  const byName = (n: string) => wf.jobs.gate!.steps.find((s) => s.name === n)!;
  assert.match(byName("Log in to GHCR").if!, /== 'pull'/);
  assert.match(byName("Install cosign").if!, /== 'pull'/);
  assert.match(byName("Fetch upstream source at the pinned commit").if!, /== 'build'/);
});

test("pins-gate workflow: the final job passes only on gate success, or skip when nothing relevant changed", () => {
  const script = wf.jobs["pins-gate"]!.steps[0]!.run!;
  const decide = (changes: string, run: string, gate: string) =>
    spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, CHANGES: changes, RUN: run, GATE: gate }, encoding: "utf8" }).status;
  assert.equal(decide("success", "true", "success"), 0);
  assert.equal(decide("success", "false", "skipped"), 0);
  assert.equal(decide("success", "true", "failure"), 1);
  assert.equal(decide("success", "true", "cancelled"), 1);
  assert.equal(decide("success", "true", "skipped"), 1);
  assert.equal(decide("failure", "", "skipped"), 1);
});

test("the committed pins.json (0.83/0.31 published, not yet gated): digests are recorded, so nothing blocks a pull by digest", () => {
  const p = real();
  assert.equal(p.images.available, true);
  assert.equal(resolveImagesSource(p, "auto").source, "pull");
  assert.equal(pullBlockers(p).length, 0); // vta and vtc digests are recorded
});
