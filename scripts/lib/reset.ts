// `npm run reset`: stop the stack and any tunnels, delete volumes, `.vta/` and the kit's own `.env` keys.
// Lives here (not in up.ts) so `npm run clean -- stack` can call exactly the same code without running up.ts's command handling.
import { rmSync } from "node:fs";
import { clearGeneratedEnv, ENV_FILE, runtime } from "../env.js";
import { anyRunFiles, resetBinaries } from "./binary-run.js";
import { clearStackFiles, dc, have, readTunnel, stopTunnels } from "./compose.js";

/** Everything: stop the stack and any tunnels, delete the volumes, the generated keys (`.vta/`) and the kit's own `.env` keys. Works in every mode. */
export async function resetAll(): Promise<void> {
  const t = readTunnel();
  const binary = runtime() === "binary";
  if (binary || anyRunFiles()) await resetBinaries();
  const hadDocker = !binary && have("docker");
  if (hadDocker) {
    const r = dc("tunnel", true, ["down", "-v", "--remove-orphans"], { inherit: true });
    if (r.status !== 0) console.error("docker compose down -v did not finish cleanly (is Docker running?). Volumes may remain: docker volume ls.");
  }
  const n = stopTunnels(t?.pids ?? []);
  clearStackFiles();
  rmSync(".vta", { recursive: true, force: true });
  const kept = clearGeneratedEnv();
  console.log(`reset: ${binary ? "binaries stopped, .vta/run deleted" : "containers and volumes removed"}${n ? `, ${n} tunnel(s) stopped` : ""}, .vta/ deleted, the kit's keys removed from ${ENV_FILE}${kept.length ? ` (kept your own: ${kept.join(", ")})` : ""}.`);
}
