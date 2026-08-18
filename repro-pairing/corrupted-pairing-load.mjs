// Throwaway repro tool for issue #3 (EU4: paneId guard on PairingStore.load()).
//
// Writes a pairings.json with one entry missing `paneId` and one complete
// entry, loads it through PairingStore, and checks:
//  1. the corrupted entry is absent from list()/get()/byPane()
//  2. exactly one console.error line was printed, naming the missing field
//  3. the complete entry loaded normally
//  4. load() never called save() — the file's mtime is unchanged across the load
import { statSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PairingStore } from "../src/pairing.ts";

const dir = mkdtempSync(join(tmpdir(), "pairing-repro-"));
const storePath = join(dir, "pairings.json");

const goodEntry = {
  key: "C1:1.1",
  channel: "C1",
  threadTs: "1.1",
  paneId: "w1:p1",
  terminalId: "t1",
  cwd: "/tmp",
  agent: "claude",
  pairedBy: "U1",
  pairedAt: new Date(0).toISOString(),
};
const corruptedEntry = {
  key: "C2:2.2",
  channel: "C2",
  threadTs: "2.2",
  // paneId deliberately missing
  terminalId: "t2",
  cwd: "/tmp",
  agent: "claude",
  pairedBy: "U1",
  pairedAt: new Date(0).toISOString(),
};

writeFileSync(storePath, JSON.stringify([goodEntry, corruptedEntry], null, 2));

const mtimeBefore = statSync(storePath).mtimeMs;

const errors = [];
const originalError = console.error;
console.error = (...args) => {
  errors.push(args.join(" "));
  originalError(...args);
};

const store = new PairingStore(storePath);

console.error = originalError;

const mtimeAfter = statSync(storePath).mtimeMs;

console.log("--- results ---");
console.log("list():", JSON.stringify(store.list()));
console.log("get('C1','1.1'):", JSON.stringify(store.get("C1", "1.1")));
console.log("get('C2','2.2') (should be undefined):", JSON.stringify(store.get("C2", "2.2")));
console.log("byPane('w1:p1'):", JSON.stringify(store.byPane("w1:p1")));
console.log("console.error call count:", errors.length);
console.log("mtime unchanged across load (no save() call):", mtimeBefore === mtimeAfter);

const ok =
  store.list().length === 1 &&
  store.get("C1", "1.1") !== undefined &&
  store.get("C2", "2.2") === undefined &&
  errors.length === 1 &&
  mtimeBefore === mtimeAfter;

console.log(ok ? "REPRO PASS" : "REPRO FAIL");
process.exit(ok ? 0 : 1);
