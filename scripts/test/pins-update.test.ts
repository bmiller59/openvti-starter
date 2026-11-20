// pins:update and pins:verify logic: offline (injected ls-remote, injected runner, temp copies; real pins.json is only read).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyBlockers, applyPlan, appendLog, compareVersions, followUp, plan, releaseTags, unverifiedLogEntry, validatePins } from "../lib/pins-update.js";
import { gateSteps, runGate, summarize, verifiedLogLine, teardownStep } from "../lib/pins-verify.js";
import type { Pins } from "../pins.js";

const text = readFileSync(new URL("../../pins.json", import.meta.url), "utf8");
const real = () => JSON.parse(text) as Pins;
const A = "a".repeat(40), B = "b".repeat(40);
const ls = (rows: [string, string][]) => rows.map(([t, r]) => `${r}\trefs/tags/${t}`).join("\n");
const clean = { dirty: "", today: "2030-01-02" };

test("compareVersions orders numerically, not lexically", () => {
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.72.1", "0.72.0"), 1);
  assert.throws(() => compareVersions("1.0", "1.0.0"));
});

test("releaseTags: only plain releases of that service; the peeled commit of an annotated tag wins", () => {
  const out = ls([["vta-service-v0.9.0", A], ["vta-service-v0.10.0", "c".repeat(40)], ["vta-service-v0.11.0-rc1", B], ["vtc-service-v0.20.0", A], ["other-v9.9.9", B]])
    + `\n${B}\trefs/tags/vta-service-v0.10.0^{}`;
  assert.deepEqual(releaseTags(out, "vta-service").map((t) => [t.version, t.ref]), [["0.9.0", A], ["0.10.0", B]]);
});

test("validatePins accepts the real pins.json and names what is wrong otherwise", () => {
  assert.deepEqual(validatePins(real()), []);
  const bad = real(); bad.vti.vta.ref = "short"; bad.vti.vtc.tag = "vtc-service-v9.9.9"; (bad.npm as Record<string, string>).x = "^1.0.0";
  const probs = validatePins(bad).join("\n");
  assert.match(probs, /vti\.vta\.ref/);
  assert.match(probs, /does not match service and version/);
  assert.match(probs, /npm x is not an exact version/);
});

function upstream(vta: string, vtc: string, sameCommit = true) {
  const p = real();
  return ls([[`vta-service-v${vta}`, A], [`vtc-service-v${vtc}`, sameCommit ? A : B], [p.vti.vta.tag, p.vti.vta.ref], [p.vti.vtc.tag, p.vti.vtc.ref]]);
}

test("a newer matched pair proposes tag, version and ref for both; nothing blocks on a clean tree", () => {
  const pl = plan({ pins: real(), lsRemote: () => upstream("0.80.0", "0.30.0"), ...clean });
  assert.equal(pl.updateAvailable, true);
  assert.deepEqual(applyBlockers(pl), []);
  assert.deepEqual(pl.changes.map((c) => c.what).sort(), ["vti.vta.ref", "vti.vta.tag", "vti.vta.version", "vti.vtc.ref", "vti.vtc.tag", "vti.vtc.version"]);
});

test("already current: no changes, no update available", () => {
  const p = real();
  const pl = plan({ pins: p, lsRemote: () => ls([[p.vti.vta.tag, p.vti.vta.ref], [p.vti.vtc.tag, p.vti.vtc.ref]]), ...clean });
  assert.equal(pl.updateAvailable, false);
  assert.deepEqual(pl.changes, []);
  assert.deepEqual(pl.blockers, []);
});

test("blockers: dirty tree, split commits, missing tag, downgrade, bad schema, upstream unreachable", () => {
  assert.match(applyBlockers(plan({ pins: real(), lsRemote: () => upstream("0.80.0", "0.30.0"), dirty: " M x", today: "t" })).join(), /not clean/);
  assert.match(plan({ pins: real(), lsRemote: () => upstream("0.80.0", "0.30.0", false), ...clean }).blockers.join(), /different commits/);
  assert.match(plan({ pins: real(), lsRemote: () => upstream("0.80.0", "0.30.0"), vtaTag: "vta-service-v9.9.9", ...clean }).blockers.join(), /vta-service-v9\.9\.9 not found/);
  assert.match(plan({ pins: real(), lsRemote: () => "", ...clean }).blockers.join(), /no vta-service-v/);
  const down = plan({ pins: real(), lsRemote: () => ls([["vta-service-v0.50.0", A], ["vtc-service-v0.10.0", A]]), ...clean });
  assert.match(down.blockers.join(), /vta 0\.72\.0 -> 0\.50\.0 is a downgrade/);
  assert.deepEqual(plan({ pins: real(), lsRemote: () => ls([["vta-service-v0.50.0", A], ["vtc-service-v0.10.0", A]]), allowDowngrade: true, ...clean }).blockers, []);
  const bad = real(); bad.vti.vta.ref = "x";
  assert.match(plan({ pins: bad, lsRemote: () => upstream("0.80.0", "0.30.0"), ...clean }).blockers.join(), /schema/);
  const boom = plan({ pins: real(), lsRemote: () => { throw new Error("offline"); }, ...clean });
  assert.match(boom.blockers.join(), /could not list upstream tags.*offline/);
});

test("a tag that moved upstream (same version, different commit) is a blocker", () => {
  const p = real();
  const pl = plan({ pins: p, lsRemote: () => ls([[p.vti.vta.tag, B], [p.vti.vtc.tag, B]]), ...clean });
  assert.match(pl.blockers.join(), /tag moved/);
});

test("mediator: by tag (resolved upstream), by commit with a version, and refusals", () => {
  const p = real();
  const lsr = (repo: string) => repo === p.messaging.mediator.repo ? ls([["v0.49.0", B]]) : upstream("0.80.0", "0.30.0");
  const byTag = plan({ pins: p, lsRemote: lsr, mediator: { ref: "v0.49.0" }, ...clean });
  assert.deepEqual(byTag.mediator, { ref: B, version: "0.49.0" });
  assert.match(plan({ pins: p, lsRemote: lsr, mediator: { ref: "v0.99.0" }, ...clean }).blockers.join(), /mediator tag v0\.99\.0 not found/);
  assert.match(plan({ pins: p, lsRemote: lsr, mediator: { ref: B }, ...clean }).blockers.join(), /--mediator-version/);
  assert.equal(plan({ pins: p, lsRemote: lsr, mediator: { ref: B, version: "0.49.0" }, ...clean }).mediator?.version, "0.49.0");
  assert.match(plan({ pins: p, lsRemote: lsr, mediator: { ref: "main" }, ...clean }).blockers.join(), /neither/);
  assert.match(plan({ pins: p, lsRemote: lsr, mediator: { ref: B, version: "0.40.0" }, ...clean }).blockers.join(), /downgrade/);
});

test("applyPlan rewrites only the pinned keys, keeps the file's formatting, and stays valid", () => {
  const p = real();
  const pl = plan({ pins: p, lsRemote: (r) => r === p.messaging.mediator.repo ? ls([["v0.49.0", B]]) : upstream("0.80.0", "0.30.0"), mediator: { ref: "v0.49.0" }, ...clean });
  const out = applyPlan(text, pl, "2030-01-02");
  const n = JSON.parse(out) as Pins;
  assert.equal(n.vti.vta.tag, "vta-service-v0.80.0");
  assert.equal(n.vti.vtc.version, "0.30.0");
  assert.equal(n.vti.vta.ref, A);
  assert.equal(n.vti.pinnedOn, "2030-01-02");
  assert.match(n.vti.why, /UNVERIFIED/);
  assert.equal(n.messaging.mediator.ref, B);
  assert.equal(n.messaging.mediator.version, "0.49.0");
  assert.equal(n.updated, "2030-01-02");
  // untouched: features, redis, npm, images, the inline platforms array
  assert.deepEqual({ ...n.vti.vta, tag: "", ref: "", version: "" }, { ...p.vti.vta, tag: "", ref: "", version: "" });
  assert.deepEqual(n.npm, p.npm);
  assert.deepEqual(n.messaging.redis, p.messaging.redis);
  assert.ok(out.includes('"platforms": ["linux/amd64", "linux/arm64"]'));
  // a diff touches few lines
  const changed = out.split("\n").filter((l, i) => l !== text.split("\n")[i]).length;
  assert.ok(changed <= 14, `changed ${changed} lines`);
});

test("applyPlan with no changes returns the text unchanged", () => {
  const p = real();
  const pl = plan({ pins: p, lsRemote: () => ls([[p.vti.vta.tag, p.vti.vta.ref], [p.vti.vtc.tag, p.vti.vtc.ref]]), ...clean });
  assert.equal(applyPlan(text, pl, "2030-01-02"), text);
});

test("follow-up lists the gate commands; the log entry is marked UNVERIFIED and appends on its own line", () => {
  const f = followUp();
  for (const c of ["images:build", "up", "e2e", "test:roles", "hello"]) assert.ok(f.includes(c), c);
  const p = real();
  const pl = plan({ pins: p, lsRemote: () => upstream("0.80.0", "0.30.0"), ...clean });
  const e = unverifiedLogEntry(pl, { vta: "0.72.0", vtc: "0.20.0", mediator: "0.48.0" }, "2030-01-02");
  assert.match(e, /^- \*\*2030-01-02\*\* · .*VTA 0\.72\.0 -> 0\.80\.0.*UNVERIFIED/);
  assert.equal(appendLog("a\nb", e), `a\nb\n${e}\n`);
  assert.equal(appendLog("a\n", e), `a\n${e}\n`);
});

test("pins:verify gate: ordered bounded steps, stops at the first failure, summary and log line", () => {
  const steps = gateSteps();
  assert.deepEqual(steps.map((s) => s.name), ["images:build", "up", "e2e", "cooldown", "test:roles", "hello"]);
  assert.ok(steps.every((s) => s.timeoutMs > 0 && s.timeoutMs <= 90 * 60_000));
  assert.equal(steps[1].env?.WITH_VTC, "1");
  assert.equal(teardownStep().args.join(" "), "run down");
  const ran: string[] = [];
  const ok = runGate(steps, (s) => { ran.push(s.name); return { status: 0, timedOut: false }; });
  assert.equal(ok.passed, true);
  assert.deepEqual(ran, steps.map((s) => s.name));
  const ran2: string[] = [];
  const bad = runGate(steps, (s) => { ran2.push(s.name); return s.name === "e2e" ? { status: null, timedOut: true } : { status: 0, timedOut: false }; });
  assert.equal(bad.passed, false);
  assert.deepEqual(ran2, ["images:build", "up", "e2e"]);
  assert.match(summarize(bad.results), /TIMEOUT\s+e2e/);
  const line = verifiedLogLine(real(), "2030-01-02");
  assert.match(line, /^- \*\*2030-01-02\*\* · Pins verified: VTA `vta-service-v0\.72\.0`/);
  assert.ok(!line.includes("UNVERIFIED"));
});

test("pins-bump workflow: schedule and manual only, SHA-pinned actions, issue only (no PR, no push, no auto-merge)", async () => {
  const { parse } = await import("yaml");
  const raw = readFileSync(new URL("../../.github/workflows/pins-bump.yml", import.meta.url), "utf8");
  const wf = parse(raw) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { permissions: Record<string, string>; steps: { uses?: string }[] }> };
  assert.deepEqual(Object.keys(wf.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(wf.permissions, { contents: "read" });
  assert.deepEqual(wf.jobs.check.permissions, { contents: "read", issues: "write" });
  for (const s of wf.jobs.check.steps) if (s.uses) assert.match(s.uses, /@[0-9a-f]{40}$/, s.uses);
  const code = raw.replace(/^\s*#.*$/gm, "");
  assert.ok(!/pull-requests|gh pr |git push|auto-merge/.test(code), "never applies, pushes or opens a PR");
  assert.match(code, /pins:update -- --json/);
});
