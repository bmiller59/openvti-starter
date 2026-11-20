// Pure logic behind `npm run pins:verify` (scripts/pins-verify.ts): the live gate after a pin change, as an ordered
// list of bounded steps, a runner that stops at the first failure, and the PINS_LOG line printed only on all-pass.
// The runner is injected so the tests never start Docker.
import type { Pins } from "../pins.js";

export interface GateStep { name: string; cmd: string; args: string[]; env?: Record<string, string>; timeoutMs: number }
export interface StepResult { name: string; ok: boolean; status: number | null; timedOut: boolean; ms: number }
/** Run one step; must enforce `timeoutMs`. */
export type StepRunner = (s: GateStep) => { status: number | null; timedOut: boolean };

const MIN = 60_000;

/** `nice -n 10` is applied to the heavy steps by the caller's `cmd`, so children inherit it. */
export function gateSteps(): GateStep[] {
  const npm = (name: string, args: string[], timeoutMs: number, env?: Record<string, string>): GateStep => ({ name, cmd: "nice", args: ["-n", "10", "npm", "run", ...args], env, timeoutMs });
  return [
    npm("images:build", ["images:build", "--", "all"], 90 * MIN),
    npm("up", ["up"], 15 * MIN, { WITH_VTC: "1" }),
    npm("e2e", ["e2e"], 20 * MIN),
    npm("test:roles", ["test:roles"], 15 * MIN),
    npm("hello", ["hello"], 5 * MIN),
  ];
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
export function verifiedLogLine(p: Pins, today: string): string {
  return `- **${today}** · Pins verified: VTA \`${p.vti.vta.tag}\` and VTC \`${p.vti.vtc.tag}\` (commit \`${p.vti.vta.ref.slice(0, 8)}\`), mediator ${p.messaging.mediator.version} (\`${p.messaging.mediator.ref.slice(0, 8)}\`) pinned. Passed by \`npm run pins:verify\`, MODE=local, one run: images:build, WITH_VTC=1 up, e2e, test:roles, hello. Not covered: MODE=tunnel, farm:*.`;
}
