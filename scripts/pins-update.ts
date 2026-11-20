// Advance the VTA/VTC pins in pins.json to the newest upstream release tags, deliberately and with guard rails.
//   npm run pins:update                         dry run: print the proposed changes, write nothing
//   npm run pins:update -- --apply              write pins.json (refuses on any blocker below)
//   npm run pins:update -- --apply --log        also append an UNVERIFIED entry to PINS_LOG.md
//   npm run pins:update -- --json               machine-readable plan (used by .github/workflows/pins-bump.yml)
// Options:
//   --vta-tag <tag> --vtc-tag <tag>   pin these release tags instead of the newest
//   --mediator <vX.Y.Z|commit>        also move the mediator pin (a bare commit needs --mediator-version <x.y.z>)
//   --allow-downgrade                 permit an older version than the current pin
// Refuses to apply when: the working tree is dirty; the VTA and VTC tags resolve to different commits (they are
// built from one commit); a tag is not found; a downgrade without --allow-downgrade; pins.json fails its schema check.
// npm exact pins and the redis tag are not touched here (edit by hand, docs/PINS.md). After --apply, run the gate:
// `npm run pins:verify` (needs Docker). Nothing here builds, starts or verifies anything.
import "./lib/cli.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { applyBlockers, applyPlan, appendLog, followUp, plan, unverifiedLogEntry, type MediatorRequest } from "./lib/pins-update.js";
import type { Pins } from "./pins.js";

const root = new URL("../", import.meta.url);
const pinsPath = new URL("pins.json", root), logPath = new URL("PINS_LOG.md", root);
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const value = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const known = new Set(["--apply", "--log", "--json", "--allow-downgrade", "--vta-tag", "--vtc-tag", "--mediator", "--mediator-version"]);
const withValue = new Set(["--vta-tag", "--vtc-tag", "--mediator", "--mediator-version"]);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i])) { console.error(`unknown argument ${argv[i]} (see --help)`); process.exit(2); }
  if (withValue.has(argv[i]) && (argv[++i] ?? "").startsWith("--")) { console.error(`${argv[i - 1]} needs a value`); process.exit(2); }
}
if (flag("--log") && !flag("--apply")) { console.error("--log only makes sense with --apply"); process.exit(2); }

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", cwd: root, timeout: 60_000, maxBuffer: 1 << 26 });
const text = readFileSync(pinsPath, "utf8");
const p = JSON.parse(text) as Pins;
const today = new Date().toISOString().slice(0, 10);
const mediator: MediatorRequest | undefined = value("--mediator") ? { ref: value("--mediator")!, version: value("--mediator-version") } : undefined;
const pl = plan({
  pins: p, today, mediator, allowDowngrade: flag("--allow-downgrade"), vtaTag: value("--vta-tag"), vtcTag: value("--vtc-tag"),
  lsRemote: (repo) => execFileSync("git", ["ls-remote", "--tags", repo], { encoding: "utf8", timeout: 60_000 }),
  dirty: git("status", "--porcelain"),
});

if (flag("--json")) {
  console.log(JSON.stringify({ updateAvailable: pl.updateAvailable, changes: pl.changes, blockers: applyBlockers(pl), vta: pl.vta?.tag, vtc: pl.vtc?.tag, ref: pl.vta?.ref }, null, 2));
  process.exit(0);
}

console.log(pl.changes.length ? "Proposed changes to pins.json:" : "No pin changes proposed (the pins are already the newest upstream release).");
for (const c of pl.changes) console.log(`  ${c.what.padEnd(32)} ${c.from.slice(0, 40)} -> ${c.to.slice(0, 40)}`);
const blockers = applyBlockers(pl);
for (const b of blockers) console.log(`BLOCKED: ${b}`);

if (!flag("--apply")) {
  console.log(blockers.length ? "\nDry run. --apply would refuse until the above is resolved." : pl.changes.length ? "\nDry run: nothing written. Re-run with --apply to write pins.json." : "\nDry run: nothing to do.");
  process.exit(0);
}
if (blockers.length) { console.error("\nRefusing to apply. pins.json is unchanged."); process.exit(1); }
if (!pl.changes.length) { console.log("Nothing to apply."); process.exit(0); }

writeFileSync(pinsPath, applyPlan(text, pl, today));
console.log("\npins.json written (not committed).");
if (flag("--log")) {
  writeFileSync(logPath, appendLog(readFileSync(logPath, "utf8"), unverifiedLogEntry(pl, { vta: p.vti.vta.version, vtc: p.vti.vtc.version, mediator: p.messaging.mediator.version }, today)));
  console.log("PINS_LOG.md: appended an UNVERIFIED entry.");
}
console.log("\n" + followUp());
