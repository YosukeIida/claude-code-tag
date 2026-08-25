import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTagMatchesVersion } from "./generate-version.mjs";

test("checkTagMatchesVersion is a no-op off a tag ref (branch push, PR check, local dev)", () => {
  assert.doesNotThrow(() => checkTagMatchesVersion("branch", "main", "0.1.0"));
  assert.doesNotThrow(() => checkTagMatchesVersion(undefined, undefined, "0.1.0"));
});

test("checkTagMatchesVersion passes when the tag matches package.json's version", () => {
  assert.doesNotThrow(() => checkTagMatchesVersion("tag", "v0.2.0", "0.2.0"));
});

test("checkTagMatchesVersion throws when the tag and package.json version disagree", () => {
  // The bug this exists to catch: package.json's version was never bumped
  // before tagging, so the release workflow would ship a binary whose
  // --version claims the previous release instead of the tagged one.
  assert.throws(() => checkTagMatchesVersion("tag", "v0.2.0", "0.1.0"), /does not match/);
});
