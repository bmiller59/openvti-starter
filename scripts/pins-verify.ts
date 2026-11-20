// The live gate after a pin change. Needs Docker and a lot of time (a cold Rust build is 25 to 40 minutes per image).
//   npm run pins:verify              build the images, start the stack, run e2e, test:roles and hello, then tear down
//   npm run pins:verify -- --plan    print the steps and timeouts, run nothing
//   --images auto|build|pull         where the images come from (default build). pull: pull the VTA and VTC by the digests in pins.json
//                                    and run images:verify first (fails closed if a digest is missing); auto: pull when pins.json
//                                    images.available is true, else build. This is what CI (.github/workflows/pins-gate.yml) uses.
//   --print-images                   print only the resolved source (pull or build) and exit; the workflow reads it
// Each step has a hard timeout and the run stops at the first failure. Only when every step passes does it print a
// PINS_LOG.md line to paste (it never edits files). The stack is torn down afterwards either way (`npm run down`).
import "./lib/cli.js";
import { spawnSync } from "node:child_process";
import { gateSteps, parseImagesChoice, pullBlockers, resolveImagesSource, runGate, summarize, teardownStep, verifiedLogLine, type GateStep } from "./lib/pins-verify.js";
import { pins } from "./pins.js";

const argv = process.argv.slice(2);
const parsed = parseImagesChoice(argv);
if ("error" in parsed) { console.error(parsed.error); process.exit(2); }
const { source, reason } = resolveImagesSource(pins(), parsed.choice);
if (argv.includes("--print-images")) { console.log(source); process.exit(0); }
const blockers = source === "pull" ? pullBlockers(pins()) : [];
if (blockers.length) { console.error(`Cannot pull: ${blockers.join("; ")}. Record the digests (docs/IMAGES.md) or use --images build.`); process.exit(2); }
const steps = gateSteps({ images: source });
console.log(`images: ${source} (${reason})`);
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
console.log(`\nGate passed. Paste into PINS_LOG.md:\n\n${verifiedLogLine(pins(), new Date().toISOString().slice(0, 10), source)}\n`);
