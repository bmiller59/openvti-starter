// Resource limits for the local image builds (images:build / setup).
//
// `nice docker build` only lowers the priority of the docker *client*; the Rust compile runs inside the Docker
// daemon (or BuildKit), which that nice does not reach, and plain `docker build` has no memory cap. So the builds
// run on a dedicated buildx builder (docker-container driver) whose container carries cgroup limits:
//   memory      hard cap. memory-swap = same (no swap), unless the host has swap at least as large as the cap: then 2x, so a
//               Rust link step that briefly peaks can spill into swap instead of being OOM-killed
//   cpu-quota   at most N CPUs
//   cpu-shares  low weight, the cgroup equivalent of `nice`: other work wins whenever the CPU is contended
// Set them (first match wins): flags `--memory 8g --cpus 4 --no-limits`, env BUILD_MEMORY / BUILD_CPUS / BUILD_LIMITS=0,
// or lines in .env. Defaults (when the machine is measured, scripts/lib/host-resources.ts): memory = half of the engine's RAM rounded down to
// whole GB, at least 6g and at most 12g; cpus = a quarter of the cores, at least 2 when there are 4 or more cores (min 1).
// Without a measurement: 6g and a quarter of the cores. --no-limits builds on the default builder (the old behaviour).
import { spawnSync } from "node:child_process";
import { LOW_RESOURCE_FALLBACKS } from "./build-help.js";
import { engineMemBytes, GIB, type HostResources } from "./host-resources.js";

export interface BuildLimits { memory: string; cpus: number; /** memory-swap, only when it is larger than `memory` */ memorySwap?: string }

/** Below these the build is refused (unless --force); see `buildPreflight`. */
export const MIN_FREE_DISK_GB = 10;
export const MIN_ENGINE_MEMORY_GB = 4;
/** Below this free disk, or a memory cap, a warning. */
export const WARN_FREE_DISK_GB = 20;
export const WARN_CAP_GB = 8;
export const DEFAULT_MEMORY_MIN_GB = 6;
export const DEFAULT_MEMORY_MAX_GB = 12;

/** Pure: pull `--memory 8g` / `--memory=8g`, `--cpus 4`, `--no-limits`, `--force` out of argv. Precedence elsewhere: flag > environment > .env > default. */
export function parseLimitFlags(argv: string[]): { rest: string[]; env: Record<string, string>; force: boolean; error?: string } {
  const rest: string[] = [];
  const env: Record<string, string> = {};
  let error: string | undefined;
  let force = false;
  const keys: Record<string, string> = { "--memory": "BUILD_MEMORY", "--cpus": "BUILD_CPUS" };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === "--no-limits") env.BUILD_LIMITS = "0";
    else if (flag === "--force") force = true;
    else if (keys[flag]) {
      const v = inline ?? argv[++i];
      if (!v || v.startsWith("--")) error = `${flag} needs a value (for example ${flag === "--memory" ? "--memory 8g" : "--cpus 4"}).`;
      else env[keys[flag]] = v;
    } else rest.push(argv[i]);
  }
  return { rest, env, force, error };
}

export const DEFAULT_MEMORY = "6g";
const MEMORY_RE = /^\d+(\.\d+)?[kmg]?b?$/i;

/** Pure: "6g" / "4096m" / "512k" / "1024" (bytes) to bytes. NaN when malformed. */
export function sizeToBytes(size: string): number {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(size.trim());
  if (!m) return NaN;
  return Number(m[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: GIB } as Record<string, number>)[m[2].toLowerCase()];
}

const fmtBytes = (b: number): string => (b % GIB === 0 ? `${b / GIB}g` : `${Math.round(b / 1024 ** 2)}m`);

/** Pure: the default memory cap. Half of the engine's RAM (stable, unlike "available", so the builder and its cache are reused), 6g to 12g. */
export function defaultMemory(res?: HostResources): string {
  const total = res ? engineMemBytes(res) : undefined;
  if (!total) return DEFAULT_MEMORY;
  const gb = Math.floor((total * 0.5) / GIB);
  return `${Math.min(DEFAULT_MEMORY_MAX_GB, Math.max(DEFAULT_MEMORY_MIN_GB, gb))}g`;
}

/** Pure: the default CPU count: a quarter of the cores, at least 2 when the machine has 4 or more, at least 1. */
export function defaultCpus(cores: number): number {
  const quarter = Math.max(1, Math.floor(cores / 4));
  return cores >= 4 ? Math.max(2, quarter) : quarter;
}

/**
 * Pure: limits from the environment, or undefined when BUILD_LIMITS=0. Throws on a malformed value. Flag/env values always win over the defaults.
 * `res` (optional) scales the default memory to the machine and lets the cap spill into swap (memory-swap 2x) when the host has swap at least as big as the cap.
 */
export function limitsFromEnv(env: Record<string, string | undefined>, cores: number, res?: HostResources): BuildLimits | undefined {
  if (env.BUILD_LIMITS === "0") return undefined;
  const memory = (env.BUILD_MEMORY ?? defaultMemory(res)).trim().toLowerCase();
  if (!MEMORY_RE.test(memory)) throw new Error(`BUILD_MEMORY=${env.BUILD_MEMORY} is not a size (examples: 6g, 4096m).`);
  const asked = env.BUILD_CPUS === undefined ? defaultCpus(cores) : Number(env.BUILD_CPUS);
  if (!Number.isFinite(asked) || asked <= 0) throw new Error(`BUILD_CPUS=${env.BUILD_CPUS} must be a positive number.`);
  const limits: BuildLimits = { memory, cpus: Math.min(asked, cores) };
  const bytes = sizeToBytes(memory);
  if (res?.hostSwapBytes && res.hostSwapBytes >= bytes) limits.memorySwap = fmtBytes(bytes * 2);
  return limits;
}

export interface Preflight { errors: string[]; warnings: string[] }

const gb = (b: number) => (b / GIB).toFixed(1);
const FALLBACKS = `Fallbacks: ${LOW_RESOURCE_FALLBACKS}.`;

/**
 * Pure: what to say before a Rust build starts. `errors` refuse the build (override: --force); `warnings` only print.
 * Thresholds: free disk on Docker's data root < 10 GB, or engine/host memory < 4 GB, refuse; free disk < 20 GB, a cap < 8g without
 * swap for the Rust images (LTO is OOM-killed on a 16 GB runner without swap, images.yml), or a single core, warn.
 */
export function buildPreflight(o: { limits: BuildLimits | undefined; res: HostResources; rust: boolean; force?: boolean }): Preflight {
  const { limits, res, rust } = o;
  const errors: string[] = [];
  const warnings: string[] = [];
  const clean = "`npm run clean` (a dry run) lists what can be reclaimed";
  const free = res.dockerRootFreeBytes;
  if (free !== undefined) {
    if (free < MIN_FREE_DISK_GB * GIB) errors.push(`only ${gb(free)} GB free${res.dockerRootDir ? ` on ${res.dockerRootDir}` : " on Docker's data root"}; a build needs at least ${MIN_FREE_DISK_GB} GB and a comfortable one ${WARN_FREE_DISK_GB} GB or more. Free space (${clean}).`);
    else if (free < WARN_FREE_DISK_GB * GIB) warnings.push(`${gb(free)} GB free on Docker's data root; plan for ${WARN_FREE_DISK_GB} GB or more (the BuildKit cache alone grows to about 12 GB). ${clean}.`);
  }
  const mem = engineMemBytes(res);
  if (mem !== undefined && mem < MIN_ENGINE_MEMORY_GB * GIB) errors.push(`only ${gb(mem)} GB of memory${res.dockerMemBytes ? " in the Docker engine (Docker Desktop: raise the VM memory in Settings > Resources)" : ""}; a Rust build needs at least ${MIN_ENGINE_MEMORY_GB} GB and is comfortable with 8 GB or more.`);
  if (limits && rust) {
    const cap = sizeToBytes(limits.memory);
    if (cap < WARN_CAP_GB * GIB && !limits.memorySwap) warnings.push(`the memory cap is ${limits.memory} with no swap; the Rust link step (LTO) can be OOM-killed below ${WARN_CAP_GB}g. Add swap, raise --memory, or see the fallbacks.`);
  }
  if (limits && limits.cpus <= 1) warnings.push(`the build is limited to 1 CPU; a cold Rust build will take well over an hour. Raise it with --cpus N if the machine has spare cores.`);
  if (errors.length) errors.push(FALLBACKS, "To build anyway at your own risk: add --force.");
  return { errors, warnings };
}

/** Pure: the builder is named after its limits, so changing them creates a fresh builder rather than reusing a stale one. */
export function builderName(l: BuildLimits): string {
  return `buildathon2-m${l.memory.replace(/b$/, "")}-c${String(l.cpus).replace(".", "_")}${l.memorySwap ? "-sw" : ""}`;
}

/** Pure: `docker buildx create` arguments. */
export function builderCreateArgs(l: BuildLimits): string[] {
  const opts = [`memory=${l.memory}`, `memory-swap=${l.memorySwap ?? l.memory}`, `cpu-period=100000`, `cpu-quota=${Math.round(l.cpus * 100000)}`, "cpu-shares=64",
    // Pin to the first N cores: cargo sizes its parallel jobs from the cores it can see, and a quota alone leaves it
    // seeing them all (12 rustc in a 6 GB cap ran out of memory), so the cap must also shrink what it sees.
    `cpuset-cpus=0-${Math.max(1, Math.floor(l.cpus)) - 1}`];
  return ["buildx", "create", "--name", builderName(l), "--driver", "docker-container", ...opts.flatMap((o) => ["--driver-opt", o])];
}

/** Pure: turn `docker build <args>` into the limited form: `nice docker buildx build --builder X --load <args>`. */
export function limitedBuildArgv(l: BuildLimits | undefined, args: string[]): string[] {
  if (!l) return ["nice", "-n", "10", "docker", "build", ...args];
  return ["nice", "-n", "10", "docker", "buildx", "build", "--builder", builderName(l), "--load", ...args];
}

/** Create the limited builder if it is not there yet. Returns an error message, or undefined when ready. */
export function ensureBuilder(l: BuildLimits): string | undefined {
  const name = builderName(l);
  if (spawnSync("docker", ["buildx", "inspect", name], { stdio: "ignore" }).status === 0) return undefined;
  const r = spawnSync("docker", builderCreateArgs(l), { encoding: "utf8" });
  if (r.status !== 0) return `could not create the resource-limited buildx builder ${name}: ${(r.stderr || r.stdout || "").trim()}\n(needs docker buildx; --no-limits builds unlimited on the default builder.)`;
  return undefined;
}

export function limitsNote(l: BuildLimits | undefined): string {
  return l ? `build limits: ${l.memory} memory (${l.memorySwap ? `memory plus swap up to ${l.memorySwap}` : "no swap"}), ${l.cpus} CPU(s), low CPU priority (change with --memory 8g --cpus 4 --no-limits, or BUILD_MEMORY / BUILD_CPUS in .env).`
           : "build limits: OFF (--no-limits), only the docker client is niced.";
}
