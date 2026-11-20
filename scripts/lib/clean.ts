// Planning and applying for `npm run clean` (scripts/clean.ts). Everything here is pure or takes injected runners
// (docker, filesystem, git, clock), so the tests never touch the real Docker daemon, temp dirs or HOME.
// The real runners are in clean-real.ts.
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Pins } from "../pins.js";
import { DEFAULT_TAR } from "./share.js";
import { canonicalTags, isRefTag } from "./image-tags.js";

export type Scope = "images" | "cache" | "source" | "tars" | "stack" | "checkout";
export const ALL_SCOPES: readonly Scope[] = ["images", "cache", "source", "tars", "stack", "checkout"];
export const DEFAULT_SCOPES: readonly Scope[] = ["images", "cache", "source"];
export const DEFAULT_OLDER_THAN_MIN = 60;
export const COLD_REBUILD_WARNING = "The next image build starts with a cold build cache: expect about 25-40 minutes per image (docs/IMAGES.md).";

// --- arguments ----------------------------------------------------------------------------------------------

export interface CleanArgs {
  scopes: Scope[];
  /** A scope was named (vs the default set). `stack` is only ever planned when named. */
  explicit: boolean;
  apply: boolean;
  yes: boolean;
  olderThanMin: number;
  includeCheckout: boolean;
  /** `tars`: a directory to look in, or a file named exactly buildathon-images.tar. Default: the current directory. */
  path?: string;
  pruneCurrent: boolean;
  removeCurrent: boolean;
}

/** Pure. `--only a,b`, `--only=a,b` or bare words name scopes; `all` is everything except `checkout` unless --include-checkout. */
export function parseCleanArgs(argv: string[]): CleanArgs | { error: string } {
  const named: string[] = [];
  const a: CleanArgs = { scopes: [], explicit: false, apply: false, yes: false, olderThanMin: DEFAULT_OLDER_THAN_MIN, includeCheckout: false, pruneCurrent: false, removeCurrent: false };
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = (): string | undefined => inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : undefined);
    if (flag === "--apply") a.apply = true;
    else if (flag === "--dry-run") dry = true;
    else if (flag === "--yes" || flag === "-y") a.yes = true;
    else if (flag === "--include-checkout") a.includeCheckout = true;
    else if (flag === "--prune-current") a.pruneCurrent = true;
    else if (flag === "--remove-current") a.removeCurrent = true;
    else if (flag === "--only") {
      const v = value();
      if (!v) return { error: "--only needs a list, for example --only images,cache" };
      named.push(...v.split(","));
    } else if (flag === "--older-than") {
      const v = value();
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n < 0) return { error: "--older-than needs a number of minutes (default 60), for example --older-than 120" };
      a.olderThanMin = n;
    } else if (flag === "--path") {
      const v = value();
      if (!v) return { error: "--path needs a directory (or a file named " + DEFAULT_TAR + ")" };
      a.path = v;
    } else if (flag.startsWith("-")) return { error: `unknown option ${flag}. See: npm run clean -- --help` };
    else named.push(...argv[i].split(","));
  }
  if (dry && a.apply) return { error: "--dry-run and --apply contradict each other; pick one." };
  const scopes = new Set<Scope>();
  for (const raw of named.map((s) => s.trim()).filter(Boolean)) {
    if (raw === "all") ALL_SCOPES.filter((s) => s !== "checkout").forEach((s) => scopes.add(s));
    else if ((ALL_SCOPES as readonly string[]).includes(raw)) scopes.add(raw as Scope);
    else return { error: `unknown scope "${raw}". Scopes: ${ALL_SCOPES.join(", ")}, all.` };
  }
  if (scopes.has("checkout") && !a.includeCheckout) return { error: "the `checkout` scope deletes the whole VTI checkout; it also needs --include-checkout." };
  if (a.includeCheckout && named.includes("all")) scopes.add("checkout");
  a.explicit = scopes.size > 0;
  a.scopes = ALL_SCOPES.filter((s) => (a.explicit ? scopes.has(s) : DEFAULT_SCOPES.includes(s)));
  return a;
}

// --- sizes ----------------------------------------------------------------------------------------------------

/** Parse docker's decimal sizes ("196MB", "12.52kB", "1.2GB"); unknown -> 0. */
export function parseSize(s: string | undefined): number {
  const m = /^\s*([\d.]+)\s*([kKMGT]?)B?\s*$/.exec(s ?? "");
  if (!m) return 0;
  const mult = { "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2] as "" | "k" | "K" | "M" | "G" | "T"];
  return Math.round(Number(m[1]) * mult);
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

// --- injected runners -----------------------------------------------------------------------------------------

export interface DockerImage { repo: string; tag: string; id: string; bytes: number }
export interface Builder { name: string; nodes: string[]; /** ISO time of the last build on it, when known */ lastActivity?: string }
export interface Volume { name: string; bytes: number }
export type Result = { ok: true } | { ok: false; message: string };
export interface CleanDocker {
  images(): DockerImage[];
  /** Names (`repo:tag`) and IDs of the images running containers use. */
  runningRefs(): string[];
  builders(): Builder[];
  volumes(): Volume[];
  imageRm(ref: string): Result;
  builderRm(name: string): Result;
  builderPrune(name: string): Result;
}
export interface FsStat { isDir: boolean; isFile: boolean; isSymlink: boolean; mtimeMs: number; uid: number }
export interface CleanFs {
  list(dir: string): string[];
  /** lstat: a symlink reports isSymlink and is never followed. */
  stat(path: string): FsStat | undefined;
  exists(path: string): boolean;
  sizeOf(path: string): number;
  rm(path: string): void;
  /** The current user's uid (undefined where there is none). */
  uid: number | undefined;
}
export type Git = (repo: string, args: string[]) => { status: number | null; stdout: string };

export interface CleanDeps {
  docker: CleanDocker;
  fs: CleanFs;
  git: Git;
  now: () => number;
  /** Directories that may hold `vti-*` exports ($TMPDIR and /tmp). */
  tmpRoots: string[];
  cwd: string;
  home: string;
  vtiPath: string;
  /** This checkout's compose project (volume prefix). */
  project: string;
  pinned: PinnedImage[];
  /** The buildx builder the next build would use (undefined when BUILD_LIMITS=0). */
  currentBuilder: string | undefined;
  /** `npm run reset`'s own code (scripts/lib/reset.ts). */
  reset: () => Promise<void>;
}

// --- plan -----------------------------------------------------------------------------------------------------

export type Action =
  | { kind: "image-rm"; ref: string }
  | { kind: "builder-rm"; name: string }
  | { kind: "builder-prune"; name: string }
  | { kind: "rm-dir"; path: string }
  | { kind: "rm-file"; path: string }
  | { kind: "stack-reset" }
  | { kind: "checkout-rm"; path: string };
export interface Item { scope: Scope; label: string; bytes: number; action: Action }
export interface Line { scope: Scope; text: string }
export interface Plan {
  items: Item[];
  /** Things seen and kept or only listed, per scope. */
  info: Line[];
  /** Things that would qualify but are refused, with the reason. */
  refused: Line[];
  warnings: string[];
}
const emptyPlan = (): Plan => ({ items: [], info: [], refused: [], warnings: [] });
const merge = (into: Plan, from: Plan) => { into.items.push(...from.items); into.info.push(...from.info); into.refused.push(...from.refused); into.warnings.push(...from.warnings); };

// images ---------------------------------------------------------------------------------------------------------

/** `keep` = every tag the current pin gives the image (`<ref8>` and `<version>-<ref8>`, scripts/lib/image-tags.ts). */
export interface PinnedImage { name: string; keep: string[] }
export const pinnedImages = (p: Pins): PinnedImage[] => [
  { name: p.vti.vta.image, keep: canonicalTags(p.vti.vta) },
  { name: p.vti.vtc.image, keep: canonicalTags(p.vti.vtc) },
  { name: p.messaging.mediator.image, keep: canonicalTags(p.messaging.mediator) },
];

/** `vta-buildathon` or `ghcr.io/org/vta-buildathon` (a pulled copy of the same image) -> the pinned entry; anything else -> undefined. */
const pinnedFor = (repo: string, pinned: PinnedImage[]) => pinned.find((p) => repo === p.name || repo.endsWith("/" + p.name));

/** Docker shows 12-char IDs in listings and full `sha256:` ones in inspect output. */
const sameId = (a: string, b: string): boolean => {
  const x = a.replace(/^sha256:/, ""), y = b.replace(/^sha256:/, "");
  return /^[0-9a-f]{12,}$/.test(x) && /^[0-9a-f]{12,}$/.test(y) && (x.startsWith(y) || y.startsWith(x));
};

/**
 * Superseded = `<pinned image name>:<8 hex>` or `:<version>-<8 hex>` whose tag is not one of the current pin's two tags. `:local`, the pinned tag, other tags and other
 * images are never candidates. An image that a kept tag (or any other tag) still points to is only untagged, so it frees nothing.
 */
export function planImages(images: DockerImage[], pinned: PinnedImage[], running: string[]): Plan {
  const plan = emptyPlan();
  const runningSet = new Set(running);
  const isCandidate = (i: DockerImage) => { const p = pinnedFor(i.repo, pinned); return p !== undefined && isRefTag(i.tag) && !p.keep.includes(i.tag); };
  const candidates = images.filter(isCandidate);
  for (const i of images.filter((x) => pinnedFor(x.repo, pinned) && !isCandidate(x))) plan.info.push({ scope: "images", text: `kept ${i.repo}:${i.tag}` });
  for (const i of candidates) {
    const ref = `${i.repo}:${i.tag}`;
    const inUse = runningSet.has(ref) || running.some((r) => sameId(r, i.id));
    if (inUse) { plan.refused.push({ scope: "images", text: `${ref} is used by a running container (stop it first: npm run down)` }); continue; }
    const sharers = images.filter((x) => x.id === i.id);
    const freed = sharers.every(isCandidate);
    plan.items.push({ scope: "images", label: freed ? `image ${ref}` : `image ${ref} (only untags: the same image is also ${sharers.filter((x) => x !== i && !isCandidate(x)).map((x) => `${x.repo}:${x.tag}`).join(", ") || "tagged otherwise"})`, bytes: freed ? i.bytes : 0, action: { kind: "image-rm", ref } });
  }
  // One image carrying several superseded tags counts once.
  const counted = new Set<string>();
  for (const it of plan.items) {
    const img = images.find((x) => `${x.repo}:${x.tag}` === (it.action as { ref: string }).ref)!;
    if (it.bytes && counted.has(img.id)) it.bytes = 0; else if (it.bytes) counted.add(img.id);
  }
  return plan;
}

/** The hint printed after a build: `undefined` when nothing is superseded. */
export function supersededHint(images: DockerImage[], pinned: PinnedImage[], running: string[]): string | undefined {
  const plan = planImages(images, pinned, running);
  if (plan.items.length === 0) return undefined;
  const bytes = plan.items.reduce((s, i) => s + i.bytes, 0);
  return `${plan.items.length} superseded image${plan.items.length === 1 ? "" : "s"}, ${formatBytes(bytes)} reclaimable: npm run clean -- images`;
}

// cache ----------------------------------------------------------------------------------------------------------

export const BUILDER_PREFIX = "buildathon2-";
export const stateVolume = (node: string) => `buildx_buildkit_${node}_state`;

export function planCache(builders: Builder[], volumes: Volume[], current: string | undefined, o: { pruneCurrent: boolean; removeCurrent: boolean }): Plan {
  const plan = emptyPlan();
  const ours = builders.filter((x) => x.name.startsWith(BUILDER_PREFIX));
  // The builder the current settings would use may not exist (the last build used --memory/--cpus flags, which are not remembered).
  // Then the most recently used one counts as current, so a clean never removes the cache the user last built with.
  if (!ours.some((b) => b.name === current) && ours.length) {
    const newest = [...ours].sort((x, y) => (y.lastActivity ?? "").localeCompare(x.lastActivity ?? ""))[0];
    plan.info.push({ scope: "cache", text: `your current settings would use ${current ?? "no limited builder"}, which does not exist; treating the most recently used builder ${newest.name} as current` });
    current = newest.name;
  }
  const size = (b: Builder) => b.nodes.reduce((s, n) => s + (volumes.find((v) => v.name === stateVolume(n))?.bytes ?? 0), 0);
  for (const b of ours) {
    const bytes = size(b);
    if (b.name !== current) {
      plan.items.push({ scope: "cache", label: `buildx builder ${b.name} and its cache volume (not the current builder)`, bytes, action: { kind: "builder-rm", name: b.name } });
    } else if (o.removeCurrent) {
      plan.items.push({ scope: "cache", label: `buildx builder ${b.name} (the CURRENT builder) and its cache volume`, bytes, action: { kind: "builder-rm", name: b.name } });
    } else if (o.pruneCurrent) {
      plan.items.push({ scope: "cache", label: `build cache of ${b.name} (the CURRENT builder; docker buildx prune)`, bytes, action: { kind: "builder-prune", name: b.name } });
    } else {
      plan.info.push({ scope: "cache", text: `kept ${b.name} (current builder, cache ${formatBytes(bytes)}); --prune-current empties its cache, --remove-current deletes the builder` });
    }
  }
  if (plan.items.length) plan.warnings.push(COLD_REBUILD_WARNING);
  return plan;
}

// source ---------------------------------------------------------------------------------------------------------

/** The names `mkdtemp(join(tmpdir, "vti-"))` in images-build.ts produces. */
export const ORPHAN_NAME = /^vti-[A-Za-z0-9]{6}$/;

/** Orphan source exports: our name pattern, a real directory (not a symlink) we own, older than `olderThanMin`, holding Cargo.toml or Dockerfile. */
export function planSource(roots: string[], fs: CleanFs, now: number, olderThanMin: number): Plan {
  const plan = emptyPlan();
  const seen = new Set<string>();
  for (const root of roots) {
    let names: string[];
    try { names = fs.list(root); } catch { continue; }
    for (const name of names.filter((n) => ORPHAN_NAME.test(n))) {
      const path = join(root, name);
      if (seen.has(path)) continue;
      seen.add(path);
      const st = fs.stat(path);
      if (!st || !st.isDir || st.isSymlink) continue;
      if (fs.uid !== undefined && st.uid !== fs.uid) { plan.refused.push({ scope: "source", text: `${path} is owned by another user` }); continue; }
      if (!fs.exists(join(path, "Cargo.toml")) && !fs.exists(join(path, "Dockerfile"))) { plan.refused.push({ scope: "source", text: `${path} has no Cargo.toml or Dockerfile, so it is not one of ours` }); continue; }
      const ageMin = (now - st.mtimeMs) / 60_000;
      if (ageMin < olderThanMin) { plan.refused.push({ scope: "source", text: `${path} is only ${Math.round(ageMin)} min old (a build may still be using it; --older-than ${olderThanMin} minutes)` }); continue; }
      plan.items.push({ scope: "source", label: `orphan source export ${path} (${Math.round(ageMin)} min old)`, bytes: fs.sizeOf(path), action: { kind: "rm-dir", path } });
    }
  }
  return plan;
}

// tars -----------------------------------------------------------------------------------------------------------

/** Only the default name from `images:export`, in `path` (a directory, or that exact file) or the current directory. */
export function planTars(path: string | undefined, cwd: string, fs: CleanFs): Plan {
  const plan = emptyPlan();
  const target = resolve(cwd, path ?? ".");
  const st = fs.stat(target);
  if (!st) { plan.info.push({ scope: "tars", text: `${target} does not exist` }); return plan; }
  const file = st.isDir && !st.isSymlink ? join(target, DEFAULT_TAR) : target;
  if (basename(file) !== DEFAULT_TAR) { plan.refused.push({ scope: "tars", text: `${file} is not named ${DEFAULT_TAR}; only that name is ever removed` }); return plan; }
  const fst = fs.stat(file);
  if (!fst) { plan.info.push({ scope: "tars", text: `no ${DEFAULT_TAR} in ${dirname(file)}` }); return plan; }
  if (!fst.isFile || fst.isSymlink) { plan.refused.push({ scope: "tars", text: `${file} is not a regular file` }); return plan; }
  plan.items.push({ scope: "tars", label: `image tar ${file}`, bytes: fs.sizeOf(file), action: { kind: "rm-file", path: file } });
  return plan;
}

// stack + other checkouts' volumes ---------------------------------------------------------------------------------

const VOLUME_SHAPE = /^(.+)_(vta-data|vtc-data|mediator-data)$/;
export function projectVolumes(volumes: Volume[], project: string): Volume[] {
  return volumes.filter((v) => { const m = VOLUME_SHAPE.exec(v.name); return m !== undefined && m !== null && m[1] === project; });
}
/** Same-shaped volumes of other checkouts: listed and never removed. */
export function foreignVolumes(volumes: Volume[], project: string): Volume[] {
  return volumes.filter((v) => { const m = VOLUME_SHAPE.exec(v.name); return m !== null && m[1] !== project; });
}

export function planStack(volumes: Volume[], project: string, cwd: string, fs: CleanFs): Plan {
  const plan = emptyPlan();
  const mine = projectVolumes(volumes, project);
  const vta = join(cwd, ".vta");
  const hasVta = fs.exists(vta);
  const bytes = mine.reduce((s, v) => s + v.bytes, 0) + (hasVta ? fs.sizeOf(vta) : 0);
  if (!mine.length && !hasVta) { plan.info.push({ scope: "stack", text: "no stack volumes or .vta/ for this checkout" }); return plan; }
  plan.items.push({ scope: "stack", label: `stack reset (same as npm run reset): stop containers and tunnels, delete volumes [${mine.map((v) => v.name).join(", ") || "none"}]${hasVta ? ", .vta/" : ""} and the kit's keys in .env`, bytes, action: { kind: "stack-reset" } });
  plan.warnings.push("stack: this deletes the generated keys and credentials (.vta/ and the kit's .env keys). It cannot be undone; your own .env lines stay.");
  return plan;
}

export function planForeign(volumes: Volume[], project: string): Plan {
  const plan = emptyPlan();
  for (const v of foreignVolumes(volumes, project)) {
    plan.info.push({ scope: "stack", text: `NOT touched (another checkout's volume): ${v.name} ${formatBytes(v.bytes)}. By hand, after checking nothing uses it: docker ps -a --filter volume=${v.name}; docker volume rm ${v.name}` });
  }
  return plan;
}

// checkout -------------------------------------------------------------------------------------------------------

export function planCheckout(vtiPath: string, cwd: string, home: string, fs: CleanFs, git: Git): Plan {
  const plan = emptyPlan();
  const path = resolve(vtiPath);
  const refuse = (why: string) => plan.refused.push({ scope: "checkout", text: `${path}: ${why}` });
  if (!fs.exists(path)) { plan.info.push({ scope: "checkout", text: `${path} is not there` }); return plan; }
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
  if (path === sep || path === resolve(home) || within(resolve(cwd), path)) { refuse("refusing: it is the filesystem root, your home, or contains this project"); return plan; }
  if (git(path, ["rev-parse", "--git-dir"]).status !== 0) { refuse("not a git checkout; not touching it"); return plan; }
  const status = git(path, ["status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim()) { refuse("has uncommitted changes (or git failed); commit or discard them first"); return plan; }
  const trees = git(path, ["worktree", "list", "--porcelain"]).stdout.split("\n").filter((l) => l.startsWith("worktree "));
  if (trees.length > 1) { refuse(`has extra git worktrees (${trees.slice(1).map((l) => l.slice(9)).join(", ")}); remove them first with git worktree remove`); return plan; }
  if (git(path, ["log", "--branches", "--not", "--remotes", "--oneline"]).stdout.trim()) { refuse("has local commits that are on no remote; push or keep them"); return plan; }
  if (git(path, ["stash", "list"]).stdout.trim()) { refuse("has stashed changes"); return plan; }
  plan.items.push({ scope: "checkout", label: `VTI checkout ${path} (clean, one worktree; re-clone with npm run images:build -- --clone)`, bytes: fs.sizeOf(path), action: { kind: "checkout-rm", path } });
  plan.warnings.push("checkout: the next build needs a fresh clone of the VTI repository (a few hundred MB, about 0.9 GB on disk).");
  return plan;
}

// --- whole plan -----------------------------------------------------------------------------------------------

export function buildPlan(args: CleanArgs, d: CleanDeps): Plan {
  const plan = emptyPlan();
  const wants = (s: Scope) => args.scopes.includes(s);
  let volumes: Volume[] = [];
  const dockerPart = (f: () => void, what: string) => { try { f(); } catch (e) { plan.warnings.push(`could not read ${what} (is Docker running?): ${(e as Error).message}`); } };
  if (wants("images")) dockerPart(() => merge(plan, planImages(d.docker.images(), d.pinned, d.docker.runningRefs())), "images");
  if (wants("cache") || wants("stack")) dockerPart(() => { volumes = d.docker.volumes(); }, "volumes");
  if (wants("cache")) dockerPart(() => merge(plan, planCache(d.docker.builders(), volumes, d.currentBuilder, args)), "buildx builders");
  if (wants("source")) merge(plan, planSource(d.tmpRoots, d.fs, d.now(), args.olderThanMin));
  if (wants("tars")) merge(plan, planTars(args.path, d.cwd, d.fs));
  if (wants("stack")) { merge(plan, planStack(volumes, d.project, d.cwd, d.fs)); merge(plan, planForeign(volumes, d.project)); }
  if (wants("checkout")) merge(plan, planCheckout(d.vtiPath, d.cwd, d.home, d.fs, d.git));
  return plan;
}

const total = (items: Item[]) => items.reduce((s, i) => s + i.bytes, 0);

export function formatPlan(plan: Plan, scopes: readonly Scope[]): string {
  const out: string[] = [];
  for (const scope of scopes) {
    const items = plan.items.filter((i) => i.scope === scope);
    const info = plan.info.filter((l) => l.scope === scope);
    const refused = plan.refused.filter((l) => l.scope === scope);
    out.push(`== ${scope}`);
    for (const i of items) out.push(`  ${formatBytes(i.bytes).padStart(9)}  ${i.label}`);
    for (const l of info) out.push(`  ${"".padStart(9)}  ${l.text}`);
    for (const l of refused) out.push(`  ${"refused".padStart(9)}  ${l.text}`);
    if (!items.length && !info.length && !refused.length) out.push("  nothing to clean");
    out.push(`  ${scope} reclaimable: ${formatBytes(total(items))}`);
  }
  out.push("", `total reclaimable: ${formatBytes(total(plan.items))} in ${plan.items.length} item${plan.items.length === 1 ? "" : "s"}`);
  for (const w of plan.warnings) out.push(`warning: ${w}`);
  return out.join("\n");
}

// --- apply ----------------------------------------------------------------------------------------------------

export interface Outcome { item: Item; ok: boolean; message?: string }

/** Defence in depth: whatever the plan says, only delete paths that still look like ours. */
export function safeToRemove(a: Action, d: Pick<CleanDeps, "tmpRoots" | "cwd" | "home" | "fs">): string | undefined {
  if (a.kind === "rm-dir") {
    if (!ORPHAN_NAME.test(basename(a.path))) return `${a.path} does not match the export-directory name pattern`;
    if (!d.tmpRoots.map((r) => resolve(r)).includes(resolve(dirname(a.path)))) return `${a.path} is not directly inside a temp directory`;
    const st = d.fs.stat(a.path);
    if (st?.isSymlink) return `${a.path} is a symlink`;
  }
  if (a.kind === "rm-file" && basename(a.path) !== DEFAULT_TAR) return `${a.path} is not named ${DEFAULT_TAR}`;
  if (a.kind === "checkout-rm" && (resolve(a.path) === sep || resolve(a.path) === resolve(d.home))) return `${a.path} is not a deletable checkout`;
  return undefined;
}

/** Run the plan's items in a safe order (stack first, so its containers are gone), one at a time; a failure does not stop the rest. */
export async function applyPlan(items: Item[], d: CleanDeps, log: (s: string) => void = () => {}): Promise<Outcome[]> {
  const order: Scope[] = ["stack", "images", "cache", "source", "tars", "checkout"];
  const sorted = [...items].sort((x, y) => order.indexOf(x.scope) - order.indexOf(y.scope));
  const outcomes: Outcome[] = [];
  for (const item of sorted) {
    const a = item.action;
    let r: Result = { ok: true };
    try {
      const unsafe = safeToRemove(a, d);
      if (unsafe) r = { ok: false, message: `refused: ${unsafe}` };
      else if (a.kind === "image-rm") r = d.docker.imageRm(a.ref);
      else if (a.kind === "builder-rm") r = d.docker.builderRm(a.name);
      else if (a.kind === "builder-prune") r = d.docker.builderPrune(a.name);
      else if (a.kind === "rm-dir" || a.kind === "rm-file" || a.kind === "checkout-rm") d.fs.rm(a.path);
      else if (a.kind === "stack-reset") await d.reset();
    } catch (e) { r = { ok: false, message: (e as Error).message }; }
    outcomes.push({ item, ok: r.ok, message: r.ok ? undefined : r.message });
    log(r.ok ? `removed: ${item.label}` : `FAILED: ${item.label}: ${r.message}`);
  }
  return outcomes;
}
