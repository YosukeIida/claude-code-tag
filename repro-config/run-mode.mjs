// Throwaway repro tool for issue #5 (EU5a: cwd-independent config discovery).
//
// Loads config.ts's exported loaders directly (no real Slack/Hub network
// activity) so each of the issue's six manual reproductions can be run as a
// plain `node --import tsx` invocation from any cwd, with env vars/XDG dirs
// controlled by the caller. Usage: MODE=spoke|hub|standalone node --import
// tsx <path-to-this-file>/run-mode.mjs
import { loadConfig, loadHubConfig, loadSpokeConfig } from "../src/config.ts";

const mode = process.env.REPRO_MODE ?? "spoke";
try {
  const config = mode === "hub" ? loadHubConfig() : mode === "standalone" ? loadConfig() : loadSpokeConfig();
  console.log(`REPRO_RESULT: loaded ${mode} config successfully:`, JSON.stringify(config));
} catch (err) {
  console.log(`REPRO_RESULT: threw: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
