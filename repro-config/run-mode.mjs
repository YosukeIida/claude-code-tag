// Throwaway repro tool for issue #5 (EU5a: cwd-independent config discovery).
//
// Loads config.ts's exported loaders directly (no real Slack/Hub network
// activity) so each of the issue's six manual reproductions can be run as a
// plain invocation from any cwd, with env vars/XDG dirs controlled by the
// caller.
//
// Deliberately never logs the loaded config object or any of its field
// values: src/config.ts already logs which path was selected, so all this
// script needs to report is pass/fail plus the mode. An earlier version
// printed the full config via JSON.stringify — a reusable path that prints
// real secrets (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CCTAG_SPOKE_TOKEN)
// whenever this is run against a real configuration, hitting the
// path-only/no-secrets hard reject issue #5 and this project's logging
// convention both apply. When a reproduction needs to prove which source
// was actually read, assert an expected sentinel value internally
// (REPRO_ASSERT_FIELD/REPRO_ASSERT_VALUE below) and report only whether it
// matched — never the value itself, so this stays safe to run against real
// config too.
//
// Usage:
//   REPRO_MODE=spoke|hub|standalone \
//   REPRO_ASSERT_FIELD=<key of the loaded config object, optional> \
//   REPRO_ASSERT_VALUE=<expected value for that field, optional> \
//   bun run-mode.mjs
import { loadConfig, loadHubConfig, loadSpokeConfig } from "../src/config.ts";

const mode = process.env.REPRO_MODE ?? "spoke";
try {
  const config = mode === "hub" ? loadHubConfig() : mode === "standalone" ? loadConfig() : loadSpokeConfig();

  const assertField = process.env.REPRO_ASSERT_FIELD;
  if (assertField) {
    const matched = config[assertField] === process.env.REPRO_ASSERT_VALUE;
    if (!matched) {
      // Never print config[assertField] or the expected value here — either
      // could be a real secret depending on which field was asserted.
      console.log(`REPRO_RESULT: FAIL — ${assertField} did not match the expected sentinel`);
      process.exitCode = 1;
      process.exit();
    }
  }
  console.log(`REPRO_RESULT: PASS — loaded ${mode} config successfully`);
} catch (err) {
  // required()'s thrown message names search paths only, never values — see
  // src/config.ts's describeSearchPaths — so this is safe to print as-is.
  console.log(`REPRO_RESULT: threw: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
