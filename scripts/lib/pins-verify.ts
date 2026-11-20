// Pure logic behind `npm run pins:verify` (scripts/pins-verify.ts): the live gate after a pin change, as an ordered
// list of bounded steps, a runner that stops at the first failure, and the PINS_LOG line printed only on all-pass.
// The runner is injected so the tests never start Docker.
import type { Pins } from "../pins.js";

export interface GateStep { name: string; cmd: string; args: string[]; env?: Record<string, string>; timeoutMs: number }
export interface StepResult { name: string; ok: boolean; status: number | null; timedOut: boolean; ms: number }
/** Run one step; must enforce `timeoutMs`. */
export type StepRunner = (s: GateStep) => { status: number | null; timedOut: boolean };

const MIN = 60_000;

export type ImagesChoice = "auto" | "build" | "pull";
export type ImagesSource = "build" | "pull";

/** Parse `--images <auto|build|pull>` (also `--images=pull`). Default `build`: the local gate always proves the upstream source builds. */
export function parseImagesChoice(argv: string[]): { choice: ImagesChoice } | { error: string } {
  const i = argv.findIndex((a) => a === "--images" || a.startsWith("--images="));
  if (i < 0) return { choice: "build" };
  const v = argv[i]!.includes("=") ? argv[i]!.split("=")[1] : argv[i + 1];
  return v === "auto" || v === "build" || v === "pull" ? { choice: v } : { error: `--images must be auto, build or pull (got ${JSON.stringify(v ?? "")})` };
}

/** Where the gate's images come from. `auto` pulls the published, signed images when pins.json says they are available, else builds from the pinned upstream refs. */
export function resolveImagesSource(p: Pins, choice: ImagesChoice): { source: ImagesSource; reason: string } {
  if (choice === "build") return { source: "build", reason: "--images build: build from the pinned upstream refs" };
  if (choice === "pull") return { source: "pull", reason: "--images pull: pull the pinned images by digest and verify them" };
  return p.images.available === true
    ? { source: "pull", reason: "pins.json images.available is true: pull the pinned images by digest and verify them" }
    : { source: "build", reason: "pins.json images.available is false: no prebuilt images, build from the pinned upstream refs" };
}

/** Reasons pulling cannot be trusted. Pull mode fails closed on these (it never falls back to a movable tag or to a build). */
export function pullBlockers(p: Pins): string[] {
  const out: string[] = [];
  for (const k of ["vta", "vtc"] as const) if (!p.images[k].digest) out.push(`pins.json images.${k}.digest is null: the image would be pulled by tag, which is not pinned`);
  return out;
}

/**
 * `nice -n 10` is applied to the heavy steps by the caller's `cmd`, so children inherit it.
 * images "build" (default): images:build from the pinned upstream refs. "pull": pull the VTA and VTC by digest and verify the
 * supply chain (images:verify), and run everything after with IMAGES=registry so the stack uses exactly those images.
 */
export function gateSteps(opts: { images?: ImagesSource; cooldownSecs?: number } = {}): GateStep[] {
  const cooldown = opts.cooldownSecs ?? DEFAULT_COOLDOWN_SECS;
  const pull = opts.images === "pull";
  const npm = (name: string, args: string[], timeoutMs: number, env?: Record<string, string>): GateStep => ({ name, cmd: "nice", args: ["-n", "10", "npm", "run", ...args], env: pull ? { IMAGES: "registry", ...env } : env, timeoutMs });
  const images = pull
    ? [
        npm("pull:vta", ["images:pull", "--", "vta", "--by-digest"], 15 * MIN),
        npm("pull:vtc", ["images:pull", "--", "vtc", "--by-digest"], 15 * MIN),
        npm("verify:vta", ["images:verify", "--", "vta"], 5 * MIN),
        npm("verify:vtc", ["images:verify", "--", "vtc"], 5 * MIN),
      ]
    : [npm("images:build", ["images:build", "--", "all"], 90 * MIN)];
  return [
    ...images,
    npm("up", ["up"], 15 * MIN, { WITH_VTC: "1" }),
    npm("e2e", ["e2e"], 20 * MIN),
    ...(cooldown > 0 ? [cooldownStep(cooldown)] : []),
    npm("test:roles", ["test:roles"], 15 * MIN),
    npm("hello", ["hello"], 5 * MIN),
  ];
}

/**
 * e2e leaves the VTC's per-address admission budget spent, and test:roles starts from it. The VTC's anonymous bucket is a burst of 10
 * refilled one token per 5 s (vtc-service routes/mod.rs: per_second(5), burst_size(10)), so it is full again after 50 s; 60 s adds margin.
 * test:roles also retries a 429 on its own (scripts/lib/rate-limit.ts); this pause makes that the exception.
 */
export const DEFAULT_COOLDOWN_SECS = 60;
export const cooldownStep = (secs: number): GateStep => ({ name: "cooldown", cmd: "sleep", args: [String(secs)], timeoutMs: secs * 1000 + 30_000 });

/** Parse `--cooldown <secs>` (or `--cooldown=<secs>`), else env PINS_COOLDOWN_SECS, else the default. 0 disables. */
export function parseCooldown(argv: string[], env: Record<string, string | undefined> = {}): { secs: number } | { error: string } {
  const i = argv.findIndex((a) => a === "--cooldown" || a.startsWith("--cooldown="));
  const raw = i >= 0 ? (argv[i]!.includes("=") ? argv[i]!.split("=")[1] : argv[i + 1] ?? "") : env.PINS_COOLDOWN_SECS;
  if (raw === undefined || (raw === "" && i < 0)) return { secs: DEFAULT_COOLDOWN_SECS };
  const n = Number(raw);
  return raw.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 600 ? { secs: n } : { error: `--cooldown (or PINS_COOLDOWN_SECS) must be whole seconds from 0 to 600 (got ${JSON.stringify(raw)})` };
}

/** Teardown, always attempted after the gate (pass or fail), reported separately. */
export const teardownStep = (): GateStep => ({ name: "down", cmd: "npm", args: ["run", "down"], timeoutMs: 5 * MIN });

export function runGate(steps: GateStep[], run: StepRunner, now: () => number = Date.now): { results: StepResult[]; passed: boolean } {
  const results: StepResult[] = [];
  for (const s of steps) {
    const t0 = now();
    const r = run(s);
    const ok = r.status === 0 && !r.timedOut;
    results.push({ name: s.name, ok, status: r.status, timedOut: r.timedOut, ms: now() - t0 });
    if (!ok) return { results, passed: false };
  }
  return { results, passed: true };
}

export const summarize = (results: StepResult[]): string =>
  results.map((r) => `${r.ok ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL"}  ${r.name.padEnd(12)} ${(r.ms / 1000).toFixed(0)}s${r.ok ? "" : ` (exit ${r.status})`}`).join("\n");

/** The line to paste into PINS_LOG.md. Only call it when every step passed. */
export function verifiedLogLine(p: Pins, today: string, images: ImagesSource = "build"): string {
  const imgStep = images === "pull" ? "images:pull by digest, images:verify" : "images:build";
  return `- **${today}** · Pins verified: VTA \`${p.vti.vta.tag}\` and VTC \`${p.vti.vtc.tag}\` (commit \`${p.vti.vta.ref.slice(0, 8)}\`), mediator ${p.messaging.mediator.version} (\`${p.messaging.mediator.ref.slice(0, 8)}\`) pinned. Passed by \`npm run pins:verify\`, MODE=local, one run: ${imgStep}, WITH_VTC=1 up, e2e, test:roles, hello. Not covered: MODE=tunnel, farm:*.`;
}
