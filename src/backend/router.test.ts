import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingStore } from "../pairing.js";
import { createTerminals, type SubmitContext, type Terminals } from "./index.js";
import { BackendUnavailable, UnknownTarget, type AgentInfo, type AgentRef } from "./types.js";

const PANE = "wT:p1";

function agent(target: string, backend: AgentInfo["backend"] = "herdr"): AgentInfo {
  return {
    ref: { target, pid: null, processStartedAt: null },
    backend,
    agent: "claude",
    sessionId: "s1",
    cwd: "/tmp/project",
    evidence: { kind: "classified", status: "idle" },
    terminalTitle: null,
    terminalId: "herdr-terminal-id",
    displayId: target,
  };
}

function herdr(overrides: Partial<Terminals> = {}): Terminals {
  return {
    async list() {
      return { agents: [], failures: [], complete: true, notices: [] };
    },
    async get() {
      return null;
    },
    async exists() {
      return true;
    },
    async read() {
      return { text: "", draft: null, complete: true };
    },
    async submit() {
      return "accepted";
    },
    openAnswer() {
      return {
        async digit() {},
        async text() {},
        async move() {},
        async confirm() {},
        complete() {},
      };
    },
    openModelAnswer() {
      return {
        async digit() {},
        async text() {},
        async move() {},
        async confirm() {},
        complete() {},
        async escape() {},
      };
    },
    openBlind() {
      return { async answer() {} };
    },
    openComposer() {
      return { async backTab() {} };
    },
    ...overrides,
  };
}

test("unprefixed Herdr IDs are passed through unchanged", async () => {
  let received: string | undefined;
  const terminals = createTerminals(
    herdr({
      async get(target) {
        received = target;
        return agent(target);
      },
    }),
  );

  const result = await terminals.get(PANE);
  assert.equal(received, PANE);
  assert.equal(result?.ref.target, PANE);
});

test("answer, model, and composer channels route to Herdr without changing the reference", () => {
  const ref: AgentRef = { target: PANE, pid: null, processStartedAt: null };
  const answer = {
    async digit() {},
    async text() {},
    async move() {},
    async confirm() {},
    complete() {},
  };
  const modelAnswer = {
    async digit() {},
    async text() {},
    async move() {},
    async confirm() {},
    complete() {},
    async escape() {},
  };
  const blind = { async answer() {} };
  const composer = { async backTab() {} };
  const terminals = createTerminals(
    herdr({
      openModelAnswer(received) {
        assert.equal(received, ref);
        return modelAnswer;
      },
      openAnswer(received) {
        assert.equal(received, ref);
        return answer;
      },
      openBlind(received) {
        assert.equal(received, ref);
        return blind;
      },
      openComposer(received) {
        assert.equal(received, ref);
        return composer;
      },
    }),
  );

  assert.equal(terminals.openAnswer(ref, {} as never), answer);
  assert.equal(terminals.openModelAnswer(ref, {} as never), modelAnswer);
  assert.equal(terminals.openBlind(ref, {} as never), blind);
  assert.equal(terminals.openComposer(ref, {} as never), composer);
});

test("orca targets fail closed before reaching the Herdr backend", async () => {
  const calls: string[] = [];
  const terminals = createTerminals(
    herdr({
      async get(target) {
        calls.push(`get:${target}`);
        return null;
      },
      async exists(target) {
        calls.push(`exists:${target}`);
        return false;
      },
      async read(target) {
        calls.push(`read:${target}`);
        return { text: "", draft: null, complete: true };
      },
      async submit(ref: AgentRef, _text: string, _ctx: SubmitContext) {
        calls.push(`submit:${ref.target}`);
        return "accepted";
      },
    }),
  );
  const target = "orca:42";

  await assert.rejects(terminals.get(target), UnknownTarget);
  assert.throws(() => terminals.exists(target), UnknownTarget);
  assert.throws(() => terminals.read(target, 20, "screen"), UnknownTarget);
  assert.throws(
    () => terminals.submit({ target, pid: 42, processStartedAt: 1 }, "hello", {} as SubmitContext),
    UnknownTarget,
  );
  const ref: AgentRef = { target, pid: 42, processStartedAt: 1 };
  assert.deepEqual(calls, []);
  assert.throws(() => terminals.openAnswer(ref, {} as never), UnknownTarget);
  assert.throws(() => terminals.openModelAnswer(ref, {} as never), UnknownTarget);
  assert.throws(() => terminals.openBlind(ref, {} as never), UnknownTarget);
  assert.throws(() => terminals.openComposer(ref, {} as never), UnknownTarget);
});

test("a Herdr result in the reserved Orca namespace raises a collision error", async () => {
  const terminals = createTerminals(
    herdr({
      async get() {
        return agent("orca:herdr-collision");
      },
    }),
  );

  await assert.rejects(terminals.get(PANE), BackendUnavailable);
});

test("a pairing file without a backend field still loads and routes to Herdr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cctag-legacy-pairing-"));
  try {
    const path = join(dir, "pairings.json");
    writeFileSync(
      path,
      JSON.stringify([
        {
          key: "C1:1.1",
          channel: "C1",
          threadTs: "1.1",
          paneId: PANE,
          terminalId: "term_legacy",
          cwd: "/tmp/project",
          pairedBy: "U1",
          pairedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const pairings = new PairingStore(path);
    const pairing = pairings.get("C1", "1.1");
    assert.ok(pairing);
    assert.equal("backend" in pairing, false);

    const received: string[] = [];
    const terminals = createTerminals(
      herdr({
        async get(target) {
          received.push(target);
          return agent(target);
        },
      }),
    );
    const result = await terminals.get(pairing.paneId);
    assert.deepEqual(received, [PANE]);
    assert.equal(result?.backend, "herdr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
