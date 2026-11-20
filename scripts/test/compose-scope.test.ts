import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { composeArgv, composeFor, composeProject } from "../lib/tunnel.js";

// Teardown (down, reset, pins:verify) must only ever touch this repo's own compose project and its volumes. Pure checks, no Docker.
const ROOT = new URL("../../", import.meta.url).pathname;

test("composeArgv names the project explicitly, derived from the given directory only", () => {
  const a = composeArgv("/work/openvti-starter", ["--profile", "vtc"], ["down", "-v", "--remove-orphans"]);
  assert.deepEqual(a, ["compose", "-p", "openvti-starter", "--profile", "vtc", "down", "-v", "--remove-orphans"]);
  const b = composeFor("tunnel", true, ["down"], "/srv/dev/code/seas/openvti-starter-worktrees/bump-rename");
  assert.equal(b[1], "-p");
  assert.equal(b[2], "bump-rename");
  assert.notEqual(b[2], "bamvtilive");
  assert.notEqual(composeProject("/a/other-kit", ""), composeProject("/a/openvti-starter", ""));
});

test("COMPOSE_PROJECT_NAME is honoured and still passed explicitly", () => {
  assert.deepEqual(composeArgv("/work/x", [], ["ps"]).slice(0, 3), ["compose", "-p", "x"]);
  assert.equal(composeProject("/work/x", "mine"), "mine");
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "test" ? [] : sources(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

test("no script calls docker compose without the explicit project (everything goes through composeArgv/composeFor)", () => {
  const offenders: string[] = [];
  for (const f of sources(join(ROOT, "scripts"))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/["']compose["']\s*,/.test(line) && !/["']compose["']\s*,\s*["']version["']/.test(line) && !f.endsWith("lib/tunnel.ts")) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("teardown never removes containers by name pattern or forces removal", () => {
  const bad: string[] = [];
  for (const f of sources(join(ROOT, "scripts"))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\bdocker\b[^\n]*["'](rm|kill|stop|prune)["']/.test(line) && !/["']image["']\s*,\s*["']rm["']|["']buildx["']/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      if (/["']rm["']\s*,\s*["']-f["']|["']-f["']\s*,\s*["']rm["']|\bxargs\b.*docker|docker (container|volume|system) prune/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("down, reset and the gate teardown go through the project-scoped dc()", () => {
  const up = readFileSync(join(ROOT, "scripts/up.ts"), "utf8");
  const reset = readFileSync(join(ROOT, "scripts/lib/reset.ts"), "utf8");
  assert.match(up, /dc\("tunnel", true, \["down", "--remove-orphans"\]/);
  assert.match(up, /dc\("tunnel", true, \["down", "-v", "--remove-orphans"\]/);
  assert.match(reset, /dc\("tunnel", true, \["down", "-v", "--remove-orphans"\]/);
  const compose = readFileSync(join(ROOT, "scripts/lib/compose.ts"), "utf8");
  assert.match(compose, /spawnSync\("docker", composeFor\(mode, withVtc, args\)/);
  const gate = readFileSync(join(ROOT, "scripts/lib/pins-verify.ts"), "utf8");
  assert.match(gate, /teardownStep[^\n]*args: \["run", "down"\]/); // npm run down, nothing else
});
