import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const lib = new URL("../lib/tmpdirs.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "tmpdirs-test-"));

/** Run a child that makes a tracked dir, prints it, then does `ending`; returns the dir and whether it still exists afterwards. */
function run(ending: string, signal?: NodeJS.Signals): Promise<{ dir: string; gone: boolean; code: number | null }> {
  const script = join(root, `child-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(script, `import { trackedTempDir } from ${JSON.stringify(lib)};\nconst d = trackedTempDir(${JSON.stringify(root)}, "vti-");\nconsole.log(d);\n${ending}\n`);
  return new Promise((done) => {
    const c = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (b) => { out += b; if (signal && out.includes("\n")) { c.kill(signal); } });
    c.on("close", (code) => { const dir = out.trim(); done({ dir, gone: !existsSync(dir), code }); });
  });
}

test("a tracked temp dir is removed on a normal exit", async () => {
  const r = await run("");
  assert.ok(r.dir.startsWith(root));
  assert.equal(r.gone, true);
});

test("and on process.exit(1)", async () => {
  const r = await run("process.exit(1);");
  assert.equal(r.gone, true);
  assert.equal(r.code, 1);
});

test("and on SIGTERM and SIGINT, with the conventional exit codes", async () => {
  const t = await run("setInterval(() => {}, 1000);", "SIGTERM");
  assert.equal(t.gone, true);
  assert.equal(t.code, 143);
  const i = await run("setInterval(() => {}, 1000);", "SIGINT");
  assert.equal(i.gone, true);
  assert.equal(i.code, 130);
});
