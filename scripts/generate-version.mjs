// Writes src/version.ts from package.json's version. Run as `node
// scripts/generate-version.mjs` (also wired as the `postinstall` script, so
// it runs automatically right after `bun install`/`npm install`).
//
// src/version.ts is gitignored, not tracked — it's regenerated every time,
// not hand-maintained. This exists because a `bun build --compile` binary is
// a single standalone executable: once deployed to a machine that doesn't
// have this repo checked out, it cannot read package.json (or anything else
// outside its own bundle) at runtime. Any version string it prints has to be
// baked into the bundle at build time, which means it has to come from a
// source file that gets compiled in, not a JSON read at startup.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// The release workflow (.github/workflows/release.yml) builds every binary
// from whatever package.json says right now, no matter which `v*` tag
// triggered it — a version bump forgotten before tagging would silently
// ship a binary whose `--version` claims the previous release (raised in
// review on PR #7). Catch it here, once, rather than writing "remember to
// bump the version first" into a runbook that's just as easy to forget as
// the bump itself.
//
// Guarded on GITHUB_REF_TYPE === "tag": GITHUB_REF_NAME is set on every
// GitHub Actions run, not just this one — a branch push or a PR check sets
// it to a branch/merge ref that was never meant to look like a version, and
// this must not fire for those.
export function checkTagMatchesVersion(refType, tagName, version) {
  if (refType !== "tag") return;
  const tagVersion = tagName.replace(/^v/, "");
  if (tagVersion !== version) {
    throw new Error(
      `[generate-version] tag "${tagName}" does not match package.json's version ` +
        `"${version}" — bump package.json's version to match before tagging.`,
    );
  }
}

checkTagMatchesVersion(process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME, pkg.version);

const outPath = join(repoRoot, "src", "version.ts");
writeFileSync(outPath, `export const VERSION = "${pkg.version}";\n`);
console.log(`[generate-version] wrote ${outPath} (VERSION = "${pkg.version}")`);
