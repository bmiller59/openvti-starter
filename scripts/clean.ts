// Reclaim disk the kit's builds leave behind. A DRY RUN by default: it lists every item with its size and a total per scope and overall.
//   npm run clean                      dry run of the default scopes (images, cache, source)
//   npm run clean -- --apply           remove them (asks first in a terminal; --yes skips the question)
//   npm run clean:dry                  same as the first line (--dry-run is accepted as an alias)
//   npm run clean -- images            only some scopes: `--only images,cache` or bare words
// Scopes:
//   images    vta/vtc/mediator:<8 hex> tags that are not the ref pinned in pins.json, one tag at a time (docker image rm).
//             Keeps :local and the pinned tag. Only images carrying the kit's org.buildathon.* labels are ever considered. An image that
//             ANY container uses (running or stopped, any compose project) is refused: "in use by <container> (<compose project>)".
//             Untags only (docker image rm <tag>, never -f). ~180-200 MB each.
//             Legacy names (<name>-buildathon, from before the rename): listed by any run, removed only when `images` is named
//             explicitly, and only when unused. Nothing else ever removes them.
//   cache     the resource-limited buildx builders (buildathon2-*) and their cache volumes: the non-current ones are removed.
//             The current builder is kept (--prune-current empties its cache, --remove-current deletes it). Observed ~12 GB.
//             WARNING: the next build is cold, about 25-40 minutes per image.
//   source    orphan `vti-XXXXXX` export directories in $TMPDIR and /tmp that images-build left (an interrupted build), only when
//             they hold Cargo.toml or a Dockerfile, belong to you and are older than --older-than minutes (default 60). ~70 MB each.
//   tars      buildathon-images.tar (the default name from images:export) in the current directory, or --path <dir|file>. 0.4+ GB.
//   stack     exactly `npm run reset`: stops the stack and tunnels, deletes this project's volumes, .vta/ and the kit's .env keys.
//             Deletes keys, so it is never a default: name it (`-- stack`) and it asks, or pass --yes.
//   checkout  delete the sibling ../verifiable-trust-infrastructure (VTI_PATH). Needs --include-checkout AND you typing the
//             directory name, even with --yes (so never in CI). Refused if it has uncommitted changes, extra worktrees,
//             local commits on no remote, or stashes. ~0.9 GB; the next build re-clones it.
//   all       every scope except checkout (add --include-checkout for that too).
// Volumes of other checkouts (`<other>_vta-data` and the like) are listed and never removed, with the commands to do it by hand.
// Without a terminal nothing is asked: a plan is printed, and --apply needs --yes. Exit status is non-zero only on errors.
import "./lib/cli.js";
import { homedir, tmpdir, cpus } from "node:os";
import { resolve } from "node:path";
import { env } from "./env.js";
import { DEFAULT_VTI_DIR } from "./lib/build-help.js";
import { builderName, limitsFromEnv } from "./lib/build-limits.js";
import { applyPlan, buildPlan, formatBytes, formatPlan, parseCleanArgs, pinnedImages, type CleanDeps } from "./lib/clean.js";
import { realCleanDocker, realCleanFs, realGit } from "./lib/clean-real.js";
import { composeProject } from "./lib/tunnel.js";
import { resetAll } from "./lib/reset.js";
import { confirm, interactive, typed } from "./lib/prompt.js";
import { pins } from "./pins.js";

const parsed = parseCleanArgs(process.argv.slice(2));
if ("error" in parsed) { console.error(parsed.error); process.exit(2); }
const args = parsed;

let currentBuilder: string | undefined;
try {
  const l = limitsFromEnv({ BUILD_MEMORY: env("BUILD_MEMORY"), BUILD_CPUS: env("BUILD_CPUS"), BUILD_LIMITS: env("BUILD_LIMITS") }, cpus().length);
  currentBuilder = l ? builderName(l) : undefined;
} catch { /* a malformed BUILD_* is images:build's error to report; here no builder counts as current */ }

const deps: CleanDeps = {
  docker: realCleanDocker, fs: realCleanFs, git: realGit, now: Date.now,
  tmpRoots: [...new Set([process.env.TMPDIR ?? tmpdir(), "/tmp"])],
  cwd: process.cwd(), home: homedir(),
  vtiPath: resolve(process.env.VTI_PATH ?? DEFAULT_VTI_DIR),
  project: composeProject(process.cwd()),
  pinned: pinnedImages(pins()),
  currentBuilder,
  reset: resetAll,
};

const plan = buildPlan(args, deps);
console.log(formatPlan(plan, args.scopes));
if (!args.apply) {
  console.log(plan.items.length ? "\nDry run: nothing was removed. Re-run with --apply (npm run clean -- --apply) to remove the items above." : "\nNothing to remove.");
  process.exit(0);
}
if (!plan.items.length) { console.log("\nNothing to remove."); process.exit(0); }

let items = plan.items;
const hasCheckout = items.some((i) => i.scope === "checkout");
if (hasCheckout && !interactive()) {
  console.log("\nSkipping the checkout: deleting it needs a terminal and typing its name, even with --yes.");
  items = items.filter((i) => i.scope !== "checkout");
}
if (!interactive() && !args.yes) {
  console.log("\nNo terminal, so nothing is asked and nothing is removed. Pass --yes to apply this plan without a prompt.");
  process.exit(0);
}
const sum = items.reduce((s, i) => s + i.bytes, 0);
if (!args.yes && !(await confirm(`\nRemove ${items.length} item${items.length === 1 ? "" : "s"} (${formatBytes(sum)})?`))) { console.log("Cancelled; nothing removed."); process.exit(0); }
const co = items.find((i) => i.scope === "checkout");
if (co && co.action.kind === "checkout-rm" && !(await typed(`\nThis deletes ${co.action.path} entirely.`, co.action.path.split("/").filter(Boolean).pop() ?? ""))) {
  console.log("The directory name did not match; the checkout is kept.");
  items = items.filter((i) => i.scope !== "checkout");
}
const outcomes = await applyPlan(items, deps, (s) => console.log(s));
const failed = outcomes.filter((o) => !o.ok);
const freed = outcomes.filter((o) => o.ok).reduce((s, o) => s + o.item.bytes, 0);
console.log(`\nDone: ${outcomes.length - failed.length} removed (about ${formatBytes(freed)}), ${failed.length} failed.`);
process.exit(failed.length ? 1 : 0);
