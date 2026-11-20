// Temp directories that are removed however the process ends: normal exit, an error exit, Ctrl-C (SIGINT) or SIGTERM.
// images-build.ts exports ~70 MB of source per image into one; before this, an interrupted build left it behind.
// `kill` is the child to stop on a signal (the running build), so the signal does not leave it orphaned.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const dirs = new Set<string>();
let kill: (() => void) | undefined;
let installed = false;

export function cleanupTempDirs(): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.clear();
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on("exit", cleanupTempDirs);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(sig, () => { try { kill?.(); } catch { /* already gone */ } cleanupTempDirs(); process.exit(code); });
  }
}

/** mkdtemp under `parent`, removed on any exit path. */
export function trackedTempDir(parent: string, prefix: string): string {
  install();
  const d = mkdtempSync(join(parent, prefix));
  dirs.add(d);
  return d;
}
/** Remove one tracked directory now (the normal path). */
export function removeTempDir(d: string): void { rmSync(d, { recursive: true, force: true }); dirs.delete(d); }
/** Register what to kill on a signal (undefined when nothing is running). */
export function onSignalKill(fn: (() => void) | undefined): void { kill = fn; }
