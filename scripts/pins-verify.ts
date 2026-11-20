// The live gate after a pin change. Needs Docker and a lot of time (a cold Rust build is 25 to 40 minutes per image).
//   npm run pins:verify              build the images, start the stack, run e2e, test:roles and hello, then tear down
//   npm run pins:verify -- --plan    print the steps and timeouts, run nothing
// Each step has a hard timeout and the run stops at the first failure. Only when every step passes does it print a
// PINS_LOG.md line to paste (it never edits files). The stack is torn down afterwards either way (`npm run down`).
import "./lib/cli.js";
import { spawnSync } from "node:child_process";
import { gateSteps, runGate, summarize, teardownStep, verifiedLogLine, type GateStep } from "./lib/pins-verify.js";
import { pins } from "./pins.js";

const steps = gateSteps();
const argv = process.argv.slice(2);
if (argv.includes("--plan")) {
  for (const s of steps) console.log(`${s.name.padEnd(12)} timeout ${s.timeoutMs / 60_000} min  ${s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${v} `).join("") : ""}${s.cmd} ${s.args.join(" ")}`);
  process.exit(0);
}
const run = (s: GateStep) => {
  console.log(`\n== ${s.name}: ${s.cmd} ${s.args.join(" ")} (timeout ${s.timeoutMs / 60_000} min)`);
  const r = spawnSync(s.cmd, s.args, { stdio: "inherit", timeout: s.timeoutMs, killSignal: "SIGTERM", env: { ...process.env, ...s.env } });
  return { status: r.status, timedOut: r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" };
};
if (spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 }).status !== 0) {
  console.error("Docker is not reachable (`docker info` failed); the gate cannot run. Nothing was started.");
  process.exit(2);
}
const { results, passed } = runGate(steps, run);
run(teardownStep());
console.log("\n" + summarize(results));
if (!passed) { console.error("\nGate FAILED: do not log this pin change as verified."); process.exit(1); }
console.log(`\nGate passed. Paste into PINS_LOG.md:\n\n${verifiedLogLine(pins(), new Date().toISOString().slice(0, 10))}\n`);
