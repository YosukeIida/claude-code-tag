import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { claudeDriver } from "../agents/claude/driver.js";
import type { SubmitContext } from "./index.js";
import type { OrcaRuntime, OrcaExecResult } from "./orca.js";
import { OrcaBackend } from "./orca.js";
import {
  BackendUnavailable,
  ExpectationLost,
  SubmitRefused,
  UnknownTarget,
  WriteOutcomeUnknown,
  type AgentRef,
} from "./types.js";

type JsonObject = Record<string, unknown>;

interface ProcessFixture {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  tty: string;
  lstart: string;
  command: string;
  paneKey?: string;
  terminalHandle?: string;
  cwd?: string;
}

interface OrcaCapture {
  terminalList: { terminals: JsonObject[]; truncated: boolean };
  worktreePs: { agents: JsonObject[] };
  process: ProcessFixture & { environment: { ORCA_PANE_KEY: string; ORCA_TERMINAL_HANDLE: string } };
}

interface SessionTransition {
  terminalList: { terminals: JsonObject[]; truncated: boolean };
  process: ProcessFixture & { environment: { ORCA_PANE_KEY: string; ORCA_TERMINAL_HANDLE: string } };
  sessionFile: Record<string, unknown>;
}

const capture = JSON.parse(
  readFileSync(new URL("./__fixtures__/orca/worktree-ps-question-state.json", import.meta.url), "utf8"),
) as OrcaCapture;
const transitions = JSON.parse(
  readFileSync(new URL("./__fixtures__/orca/claude-session-transitions.json", import.meta.url), "utf8"),
) as { snapshots: Array<SessionTransition & { state: string }> };
const PANE = capture.process.environment.ORCA_PANE_KEY;
const HANDLE = capture.process.environment.ORCA_TERMINAL_HANDLE;
const TARGET = `orca:${PANE}`;
const HOME = "/fake-home";
const SESSION_PATH = (pid: number) => `${HOME}/.claude/sessions/${pid}.json`;

function success(result: unknown): OrcaExecResult {
  return { stdout: JSON.stringify({ ok: true, result }), stderr: "", exitCode: 0 };
}

function failure(code: string, message: string): OrcaExecResult {
  return { stdout: JSON.stringify({ ok: false, error: { code, message } }), stderr: "", exitCode: 1 };
}

function processLine(row: ProcessFixture): string {
  return `${row.pid} ${row.ppid} ${row.pgid} ${row.tpgid} ${row.tty} ${row.lstart} ${row.command}`;
}

function terminalFor(paneKey: string, handle: string, overrides: JsonObject = {}): JsonObject {
  const [tabId, leafId] = paneKey.split(":");
  return {
    handle,
    tabId,
    leafId,
    writable: true,
    connected: true,
    orphaned: false,
    title: "Claude test terminal",
    ...overrides,
  };
}

class FakeOrcaRuntime implements OrcaRuntime {
  readonly homeDir = HOME;
  readonly bin = "/fake/orca";
  readonly calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  readonly readPaths: string[] = [];
  readonly sessionFiles = new Map<string, string>();
  readonly staleHandles = new Set<string>();
  readonly sendCalls: Array<{ args: string[]; timeoutMs: number }> = [];
  acceptedInputWrites = 0;
  sendReceipt: JsonObject = {
    send: { accepted: true, prompt: { stages: ["input_accepted", "turn_started"] } },
  };
  sendFailure: OrcaExecResult | null = null;
  sendFailureAfterAccept = false;
  afterSend: (() => void) | null = null;
  terminalListHook: (() => void) | null = null;
  screenReadHook: (() => void) | null = null;

  processes: ProcessFixture[] = [];
  terminals: JsonObject[] = [];
  terminalListTruncated: unknown = false;
  worktreeAgents: JsonObject[] = [];
  worktreePsTruncated = false;
  hookStatuses: JsonObject[] = [{ agent: "claude", state: "installed" }];
  showFields: JsonObject = { agentWait: null };
  screen: JsonObject = {
    handle: HANDLE,
    status: "running",
    tail: ["line one", "line two"],
    draft: "unsent draft",
    source: "screen",
    limited: false,
    truncated: false,
  };
  terminalListFailure = false;

  constructor() {
    this.loadQuestionFixture();
  }

  loadQuestionFixture(): void {
    const process: ProcessFixture = {
      ...capture.process,
      paneKey: capture.process.environment.ORCA_PANE_KEY,
      terminalHandle: capture.process.environment.ORCA_TERMINAL_HANDLE,
      cwd: "/workspace-B",
    };
    this.processes = [process];
    this.terminals = capture.terminalList.terminals.map((terminal) => ({ ...terminal }));
    this.terminalListTruncated = capture.terminalList.truncated;
    this.worktreeAgents = capture.worktreePs.agents.map((agent) => ({ ...agent }));
    this.setSession(process.pid, { sessionId: "<session-A>" });
  }

  setSession(pid: number, session: Record<string, unknown>): void {
    this.sessionFiles.set(SESSION_PATH(pid), JSON.stringify(session));
  }

  async readFile(path: string): Promise<string> {
    this.readPaths.push(path);
    const content = this.sessionFiles.get(path);
    if (content === undefined) throw new Error("fake session file is missing");
    return content;
  }

  async execFile(file: string, args: string[], options: { timeoutMs: number }): Promise<OrcaExecResult> {
    this.calls.push({ file, args: [...args], timeoutMs: options.timeoutMs });
    if (file === "ps") {
      if (args[0] === "-axww") return { stdout: this.processes.map(processLine).join("\n"), stderr: "", exitCode: 0 };
      if (args[0] === "eww") {
        const pidArg = args[args.indexOf("-p") + 1] ?? "";
        const pids = new Set(pidArg.split(",").map(Number));
        const stdout = this.processes
          .filter((row) => pids.has(row.pid))
          .map((row) => {
            const environment = [
              row.paneKey ? `ORCA_PANE_KEY=${row.paneKey}` : "",
              row.terminalHandle ? `ORCA_TERMINAL_HANDLE=${row.terminalHandle}` : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `${row.pid} ${row.command}${environment ? ` ${environment}` : ""}`;
          })
          .join("\n");
        return { stdout, stderr: "", exitCode: 0 };
      }
    }
    if (file === "lsof") {
      const pidArg = args[args.indexOf("-p") + 1] ?? "";
      const pids = new Set(pidArg.split(",").map(Number));
      const stdout = this.processes
        .filter((row) => pids.has(row.pid) && row.cwd)
        .map((row) => `p${row.pid}\nfcwd\nn${row.cwd}`)
        .join("\n");
      return { stdout, stderr: "", exitCode: 0 };
    }
    if (file !== this.bin) throw new Error(`unexpected fake command: ${file}`);

    if (args[0] === "terminal" && args[1] === "list") {
      if (this.terminalListFailure) return failure("runtime_unavailable", "runtime not running");
      const result = success({ terminals: this.terminals, truncated: this.terminalListTruncated });
      this.terminalListHook?.();
      return result;
    }
    if (args[0] === "worktree" && args[1] === "ps") {
      return success({ agents: this.worktreeAgents, truncated: this.worktreePsTruncated });
    }
    if (args[0] === "agent" && args[1] === "hooks" && args[2] === "status") {
      return success({ statuses: this.hookStatuses });
    }
    if (args[0] === "terminal" && args[1] === "show") {
      const handle = args[args.indexOf("--terminal") + 1] ?? "";
      if (this.staleHandles.has(handle) || !this.terminals.some((terminal) => terminal.handle === handle)) {
        return failure("terminal_handle_stale", "terminal_handle_stale");
      }
      const terminal = this.terminals.find((item) => item.handle === handle)!;
      return success({ terminal: { ...terminal, ...this.showFields } });
    }
    if (args[0] === "terminal" && args[1] === "send") {
      this.sendCalls.push({ args: [...args], timeoutMs: options.timeoutMs });
      if (this.sendFailure) {
        if (this.sendFailureAfterAccept) {
          const send = this.sendReceipt.send;
          if (typeof send === "object" && send !== null && (send as JsonObject).accepted === true) {
            this.acceptedInputWrites++;
          }
          this.afterSend?.();
        }
        return this.sendFailure;
      }
      const send = this.sendReceipt.send;
      if (typeof send === "object" && send !== null && (send as JsonObject).accepted === true) {
        this.acceptedInputWrites++;
      }
      this.afterSend?.();
      return success(this.sendReceipt);
    }
    if (args[0] === "terminal" && args[1] === "read") {
      const result = success({ terminal: { ...this.screen } });
      this.screenReadHook?.();
      return result;
    }
    throw new Error(`unexpected fake Orca command: ${args.join(" ")}`);
  }
}

function backend(runtime: FakeOrcaRuntime): OrcaBackend {
  return new OrcaBackend(runtime.bin, runtime);
}

function currentRef(row: ProcessFixture = capture.process): AgentRef {
  return {
    target: `orca:${row.paneKey ?? PANE}`,
    pid: row.pid,
    processStartedAt: Date.parse(row.lstart),
  };
}

function capturedClaudeScreen(name: string): JsonObject {
  const fixture = JSON.parse(
    readFileSync(new URL(`../agents/claude/__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as { terminal: JsonObject };
  return fixture.terminal;
}

function capturedText(screen: JsonObject): string {
  const tail = screen.tail;
  if (!Array.isArray(tail) || !tail.every((line) => typeof line === "string")) {
    throw new Error("captured Claude screen has no string tail");
  }
  return tail.join("\n");
}

function capturedQuestion(screen: JsonObject) {
  const prompt = claudeDriver.parseBlockedPane(capturedText(screen));
  if (prompt.kind !== "question") throw new Error("captured Claude screen is not a verified question");
  return prompt;
}

function submitContext(cancelled: () => boolean = () => false): SubmitContext {
  return {
    driver: claudeDriver,
    cancelled,
    transcriptGrew: () => false,
    retryLimit: 0,
    pollIntervalMs: 0,
  };
}
function assertLastWriteOrder(runtime: FakeOrcaRuntime, path: string): void {
  const commands = runtime.calls.map(({ file, args }) =>
    file === "ps" ? `ps ${args[0]}` : `${args[0]} ${args[1]}`,
  );
  assert.deepEqual(
    commands.slice(-5),
    ["terminal list", "terminal read", "ps -axww", "ps eww", "terminal send"],
    path,
  );
}

function fromTransition(snapshot: SessionTransition & { state: string }): ProcessFixture {
  return {
    ...snapshot.process,
    paneKey: snapshot.process.environment.ORCA_PANE_KEY,
    terminalHandle: snapshot.process.environment.ORCA_TERMINAL_HANDLE,
    cwd: "/scratch",
  };
}

function installTransition(runtime: FakeOrcaRuntime, snapshot: SessionTransition & { state: string }): void {
  const process = fromTransition(snapshot);
  runtime.processes = [process];
  runtime.terminals = snapshot.terminalList.terminals.map((terminal) => ({ ...terminal }));
  runtime.terminalListTruncated = snapshot.terminalList.truncated;
  runtime.worktreeAgents = [];
  runtime.setSession(process.pid, snapshot.sessionFile);
}

test("discovers the Claude process and joins terminal, worktree state, cwd, and session evidence", async () => {
  const runtime = new FakeOrcaRuntime();
  const result = await backend(runtime).list();

  assert.equal(result.complete, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.notices, []);
  assert.equal(result.agents.length, 1);
  const agent = result.agents[0]!;
  assert.equal(agent.ref.target, TARGET);
  assert.equal(agent.ref.pid, capture.process.pid);
  assert.equal(agent.ref.processStartedAt, Date.parse(capture.process.lstart));
  assert.equal(agent.backend, "orca");
  assert.equal(agent.agent, "claude");
  assert.equal(agent.sessionId, "<session-A>");
  assert.equal(agent.cwd, "/workspace-B");
  assert.deepEqual(agent.evidence, {
    kind: "hint",
    state: "waiting",
    waitingSince: capture.worktreePs.agents[0]!.stateStartedAt,
  });
  assert.equal(agent.terminalId, HANDLE);
  assert.deepEqual(runtime.readPaths, [SESSION_PATH(capture.process.pid)]);
  assert.ok(runtime.calls.every((call) => call.timeoutMs === 5_000));
});
test("recognizes Claude Code running through its Node entrypoint", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.processes = [
    {
      ...runtime.processes[0]!,
      command: "/opt/homebrew/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    },
  ];

  const result = await backend(runtime).list();
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]!.agent, "claude");
});

test("truncated terminal lists make discovery incomplete", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminalListTruncated = true;
  const result = await backend(runtime).list();
  assert.equal(result.complete, false);
});

test("get and exists reject missing targets from incomplete terminal lists", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminals = [];
  assert.ok(runtime.processes.some((process) => process.paneKey === PANE), "the probe keeps a live Orca process");
  const terminals = backend(runtime);

  for (const truncated of [true, undefined, "false"]) {
    runtime.terminalListTruncated = truncated;
    assert.equal((await terminals.list()).complete, false, "incomplete discovery must remain marked incomplete");
    await assert.rejects(terminals.get(TARGET), BackendUnavailable);
    await assert.rejects(terminals.exists(TARGET), BackendUnavailable);
  }

  runtime.terminalListTruncated = false;
  assert.equal(await terminals.get(TARGET), null);
  assert.equal(await terminals.exists(TARGET), false);
});

test("missing or malformed terminal-list truncated flags make discovery incomplete", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminalListTruncated = undefined;
  assert.equal((await backend(runtime).list()).complete, false);

  runtime.terminalListTruncated = "false";
  assert.equal((await backend(runtime).list()).complete, false);
});

test("screen reads are full-frame and reject non-positive line counts", async () => {
  const runtime = new FakeOrcaRuntime();
  const terminals = backend(runtime);

  await assert.rejects(terminals.read(TARGET, 0, "screen"), /lines must be a positive integer/);
  assert.equal(runtime.calls.length, 0, "invalid line counts must be rejected before any CLI call");

  const complete = await terminals.read(TARGET, 40, "screen");
  assert.deepEqual(complete, { text: "line one\nline two", draft: "unsent draft", complete: true });
  const readCall = runtime.calls.find(({ args }) => args[0] === "terminal" && args[1] === "read");
  assert.ok(readCall, "the probe must build a terminal read command");
  assert.deepEqual(readCall.args.slice(0, 5), ["terminal", "read", "--terminal", HANDLE, "--screen"]);
  assert.equal(readCall.args.includes("--limit"), false, "screen reads must not send a zero or truncating limit");

  runtime.screen = { ...runtime.screen, limited: true };
  assert.equal((await terminals.read(TARGET, 40, "history")).complete, false);
  runtime.screen = { ...runtime.screen, limited: false, truncated: true };
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
  runtime.screen = { ...runtime.screen, source: "screen-unavailable", truncated: false };
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
  runtime.screen = { source: "screen", status: "running", tail: ["shortened output"] };
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
  runtime.screen = { source: "screen", status: "running", limited: false, truncated: false, tail: ["valid", 42] };
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, false);
});

test("Codex and no-tty Claude daemon processes are never listed", async () => {
  const runtime = new FakeOrcaRuntime();
  const claudeDaemon: ProcessFixture = {
    pid: 40001,
    ppid: 1,
    pgid: 40001,
    tpgid: 0,
    tty: "??",
    lstart: "Mon Sep 28 17:05:36 2026",
    command: "claude",
    paneKey: "daemon-pane",
    terminalHandle: "daemon-terminal",
    cwd: "/daemon",
  };
  const codex: ProcessFixture = {
    pid: 40002,
    ppid: 1,
    pgid: 40002,
    tpgid: 40002,
    tty: "ttys020",
    lstart: "Mon Sep 28 17:06:36 2026",
    command: "codex",
    paneKey: "codex-pane",
    terminalHandle: "codex-terminal",
    cwd: "/codex",
  };
  runtime.processes = [claudeDaemon, codex];
  runtime.terminals = [terminalFor("daemon-pane", "daemon-terminal"), terminalFor("codex-pane", "codex-terminal")];
  runtime.worktreeAgents = [];

  const result = await backend(runtime).list();
  assert.deepEqual(result.agents, []);
  assert.ok(result.notices.includes("Orca 上の Codex は未対応です"));
});

test("does not promote a Codex child of Claude to an Orca agent", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const codex: ProcessFixture = {
    ...parent,
    pid: 90006,
    ppid: parent.pid,
    pgid: 90006,
    tpgid: 0,
    tty: "??",
    lstart: "Mon Sep 28 20:31:00 2026",
    command: "codex",
    paneKey: "codex-tab:codex-leaf",
    terminalHandle: "codex-terminal",
    cwd: "/codex",
  };
  runtime.processes = [parent, codex];

  const result = await backend(runtime).list();
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]!.agent, "claude");
  assert.ok(result.notices.includes("Orca 上の Codex は未対応です"));
});

test("a same-tty foreground child blocks both discovery and sameProcess", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const terminals = backend(runtime);
  const initiallyListed = await terminals.list();
  assert.equal(initiallyListed.agents.length, 1);
  const ref = initiallyListed.agents[0]!.ref;
  assert.equal(await terminals.sameProcess(ref), true);

  const child: ProcessFixture = {
    ...parent,
    pid: 90001,
    ppid: parent.pid,
    lstart: "Mon Sep 28 20:30:00 2026",
    command: "claude",
  };
  runtime.processes = [parent, child];
  assert.deepEqual((await terminals.list()).agents, []);
  assert.equal(await terminals.sameProcess(ref), false);
  assert.equal(await terminals.get(TARGET), null);
});

test("finds a foreground Claude descendant through a non-agent shell process", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const terminals = backend(runtime);
  const ref = currentRef(parent);
  const shell: ProcessFixture = {
    ...parent,
    pid: 90004,
    ppid: parent.pid,
    pgid: 90004,
    tpgid: parent.tpgid,
    command: "bash -lc claude",
  };
  const child: ProcessFixture = {
    ...parent,
    pid: 90005,
    ppid: shell.pid,
    pgid: 90005,
    tpgid: 90005,
    lstart: "Mon Sep 28 20:32:00 2026",
    command: "claude",
    paneKey: "other-tab:other-leaf",
    terminalHandle: "missing-child",
    cwd: "/other",
  };
  runtime.processes = [parent, shell, child];

  assert.deepEqual((await terminals.list()).agents, []);
  assert.equal(await terminals.sameProcess(ref), false);
});

test("a no-tty Bash child does not block its foreground parent", async () => {
  const runtime = new FakeOrcaRuntime();
  const parent = runtime.processes[0]!;
  const child: ProcessFixture = {
    ...parent,
    pid: 90002,
    ppid: parent.pid,
    pgid: 90002,
    tpgid: 0,
    tty: "??",
    lstart: "Mon Sep 28 20:30:00 2026",
    command: "bash -lc 'claude -p'",
  };
  runtime.processes = [parent, child];
  const terminals = backend(runtime);
  const listed = await terminals.list();
  assert.equal(listed.agents.length, 1);
  assert.equal(await terminals.sameProcess(listed.agents[0]!.ref), true);
});

test("multiple unrelated candidates in one pane remain unresolved", async () => {
  const runtime = new FakeOrcaRuntime();
  const first = runtime.processes[0]!;
  const second: ProcessFixture = {
    ...first,
    pid: 90003,
    ppid: 1,
    lstart: "Mon Sep 28 20:31:00 2026",
  };
  runtime.processes = [first, second];
  assert.deepEqual((await backend(runtime).list()).agents, []);
});

test("sameProcess rejects PID reuse and an Orca pane-key mismatch", async () => {
  const runtime = new FakeOrcaRuntime();
  const terminals = backend(runtime);
  const ref = currentRef(runtime.processes[0]);

  runtime.processes = [{ ...runtime.processes[0]!, lstart: "Mon Sep 28 21:00:00 2026" }];
  assert.equal(await terminals.sameProcess(ref), false);

  runtime.processes = [{ ...runtime.processes[0]!, lstart: capture.process.lstart, paneKey: "another-pane" }];
  assert.equal(await terminals.sameProcess(ref), false);
});

test("orphaned terminal handles resolve through the shared pane resolver", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminals = [
    terminalFor(PANE, HANDLE, {
      tabId: "pty:orphan",
      leafId: "pty:orphan",
      orphaned: true,
    }),
  ];
  const terminals = backend(runtime);

  const listed = await terminals.list();
  assert.equal(listed.agents.length, 1);
  assert.equal(listed.agents[0]!.terminalId, HANDLE);
  assert.equal((await terminals.get(TARGET))?.terminalId, HANDLE);
  assert.equal(await terminals.exists(TARGET), true);
  assert.equal((await terminals.read(TARGET, 40, "screen")).complete, true);
});

test("an inherited handle cannot bind a different ordinary pane", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.processes = [
    { ...runtime.processes[0]!, paneKey: "tab-one:leaf-one", terminalHandle: "handle-other" },
  ];
  runtime.terminals = [terminalFor("tab-other:leaf-other", "handle-other")];
  const terminals = backend(runtime);
  const target = "orca:tab-one:leaf-one";

  assert.deepEqual((await terminals.list()).agents, []);
  assert.equal(await terminals.get(target), null);
  assert.equal(await terminals.exists(target), false);
  await assert.rejects(terminals.read(target, 40, "screen"), UnknownTarget);
  assert.equal(
    runtime.calls.some(({ args }) => args[0] === "terminal" && args[1] === "read"),
    false,
  );

  const otherPane = {
    ...runtime.processes[0]!,
    pid: 40103,
    ppid: 1,
    pgid: 40103,
    tpgid: 40103,
    tty: "ttys103",
    paneKey: "tab-other:leaf-other",
    terminalHandle: "handle-other-pane",
    cwd: "/other",
  };
  runtime.processes = [...runtime.processes, otherPane];
  runtime.terminals = [terminalFor("tab-other:leaf-other", "handle-other", { orphaned: true })];
  const orphanedOrdinary = backend(runtime);
  assert.deepEqual((await orphanedOrdinary.list()).agents, []);
  assert.equal(await orphanedOrdinary.get(target), null);
  assert.equal(await orphanedOrdinary.exists(target), false);
  await assert.rejects(orphanedOrdinary.read(target, 40, "screen"), UnknownTarget);
});

test("direct pane matches win when two process environment handles are swapped", async () => {
  const runtime = new FakeOrcaRuntime();
  const original = runtime.processes[0]!;
  const first: ProcessFixture = {
    ...original,
    pid: 40101,
    ppid: 1,
    pgid: 40101,
    tpgid: 40101,
    tty: "ttys101",
    paneKey: "tab-one:leaf-one",
    terminalHandle: "handle-two",
    cwd: "/workspace-one",
  };
  const second: ProcessFixture = {
    ...original,
    pid: 40102,
    ppid: 1,
    pgid: 40102,
    tpgid: 40102,
    tty: "ttys102",
    paneKey: "tab-two:leaf-two",
    terminalHandle: "handle-one",
    cwd: "/workspace-two",
  };
  runtime.processes = [first, second];
  runtime.terminals = [
    terminalFor(first.paneKey!, "handle-one"),
    terminalFor(second.paneKey!, "handle-two"),
  ];
  runtime.setSession(first.pid, { sessionId: "<session-one>" });
  runtime.setSession(second.pid, { sessionId: "<session-two>" });
  const terminals = backend(runtime);
  const firstTarget = `orca:${first.paneKey}`;
  const secondTarget = `orca:${second.paneKey}`;

  const listed = await terminals.list();
  assert.equal(listed.agents.find((agent) => agent.ref.target === firstTarget)?.terminalId, "handle-one");
  assert.equal(listed.agents.find((agent) => agent.ref.target === secondTarget)?.terminalId, "handle-two");
  assert.equal((await terminals.get(firstTarget))?.terminalId, "handle-one");
  assert.equal((await terminals.get(secondTarget))?.terminalId, "handle-two");
  assert.equal(await terminals.exists(firstTarget), true);
  await terminals.read(firstTarget, 40, "screen");
  const readCalls = runtime.calls.filter(({ args }) => args[0] === "terminal" && args[1] === "read");
  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0]!.args[3], "handle-one");
});

test("stale and exited terminals are not returned or considered live", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.staleHandles.add(HANDLE);
  const terminals = backend(runtime);
  assert.equal(await terminals.get(TARGET), null);
  assert.equal(await terminals.exists(TARGET), false);

  runtime.staleHandles.clear();
  runtime.terminals = runtime.terminals.map((terminal) => ({ ...terminal, writable: false, exitCause: "process exited" }));
  assert.equal(await terminals.get(TARGET), null);
  assert.equal(await terminals.exists(TARGET), false);
});


test("Claude resume and clear transitions update session identity without changing sameProcess policy", async () => {
  const runtime = new FakeOrcaRuntime();
  const beforeResume = transitions.snapshots.find((snapshot) => snapshot.state === "before-resume")!;
  const resumed = transitions.snapshots.find((snapshot) => snapshot.state === "after-resume-same-session")!;
  const cleared = transitions.snapshots.find((snapshot) => snapshot.state === "after-clear-new-session")!;
  const terminals = backend(runtime);

  installTransition(runtime, beforeResume);
  const first = await terminals.get(`orca:${beforeResume.process.environment.ORCA_PANE_KEY}`);
  assert.equal(first?.sessionId, beforeResume.sessionFile.sessionId);

  installTransition(runtime, resumed);
  const resumedAgent = await terminals.get(`orca:${resumed.process.environment.ORCA_PANE_KEY}`);
  assert.equal(resumedAgent?.sessionId, resumed.sessionFile.sessionId);
  assert.equal(await terminals.sameProcess(first!.ref), false);

  installTransition(runtime, cleared);
  const clearedAgent = await terminals.get(`orca:${cleared.process.environment.ORCA_PANE_KEY}`);
  assert.equal(clearedAgent?.sessionId, cleared.sessionFile.sessionId);
  assert.equal(await terminals.sameProcess(resumedAgent!.ref), true);
});

test("unreadable Claude session files skip the agent with a notice", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.sessionFiles.clear();
  const result = await backend(runtime).list();
  assert.deepEqual(result.agents, []);
  assert.ok(result.notices.some((notice) => notice.includes("セッションを特定できないため接続できません")));
});

test("missing Claude hooks produce a state-availability notice", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.hookStatuses = [{ agent: "claude", state: "missing" }];
  const result = await backend(runtime).list();
  assert.ok(result.notices.some((notice) => notice.includes("Claude hooks are not installed")));
});

test("runtime_unavailable becomes BackendUnavailable and an incomplete list", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.terminalListFailure = true;
  const terminals = backend(runtime);
  const listed = await terminals.list();
  assert.equal(listed.complete, false);
  assert.equal(listed.agents.length, 0);
  assert.ok(listed.failures.some((failure) => failure.backend === "orca"));
  await assert.rejects(terminals.get(TARGET), BackendUnavailable);
  await assert.rejects(terminals.exists(TARGET), BackendUnavailable);
  await assert.rejects(terminals.read(TARGET, 40, "screen"), BackendUnavailable);
});

test("Orca submit refuses all five unsafe outcomes without accepted input", async () => {
  const idle = () => capturedClaudeScreen("idle-composer.screen.json");
  const cases: Array<{
    reason: SubmitRefused["reason"];
    sendAttempts: number;
    prepare(runtime: FakeOrcaRuntime): AgentRef;
  }> = [
    {
      reason: "agent-changed",
      sendAttempts: 0,
      prepare: () => {
        const ref = currentRef();
        return { ...ref, processStartedAt: (ref.processStartedAt ?? 0) + 1 };
      },
    },
    {
      reason: "incomplete-screen",
      sendAttempts: 0,
      prepare: (runtime) => {
        runtime.screen = { ...idle(), limited: true };
        return currentRef();
      },
    },
    {
      reason: "not-idle",
      sendAttempts: 0,
      prepare: (runtime) => {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
        return currentRef();
      },
    },
    {
      reason: "draft",
      sendAttempts: 0,
      prepare: (runtime) => {
        runtime.screen = { ...idle(), draft: "unsent draft" };
        return currentRef();
      },
    },
    {
      reason: "gate",
      sendAttempts: 1,
      prepare: (runtime) => {
        runtime.sendFailure = failure("agent_prompt_blocked", "prompt is blocking");
        return currentRef();
      },
    },
  ];

  for (const testCase of cases) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = idle();
    const ref = testCase.prepare(runtime);
    await assert.rejects(backend(runtime).submit(ref, "hello", submitContext()), (error: unknown) =>
      error instanceof SubmitRefused && error.reason === testCase.reason,
    );
    assert.equal(runtime.sendCalls.length, testCase.sendAttempts, testCase.reason);
    assert.equal(runtime.acceptedInputWrites, 0, testCase.reason);
  }
});

test("Orca submit separates started and accepted receipts and never resends ambiguity", async () => {
  for (const scenario of [
    {
      stages: ["input_accepted", "turn_started"],
      expected: "started",
    },
    {
      stages: ["input_accepted"],
      expected: "accepted",
    },
  ] as const) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = capturedClaudeScreen("idle-composer.screen.json");
    runtime.sendReceipt = { send: { accepted: true, prompt: { stages: [...scenario.stages] } } };
    assert.equal(await backend(runtime).submit(currentRef(), "hello", submitContext()), scenario.expected);
    assert.equal(runtime.sendCalls.length, 1);
    assert.equal(runtime.acceptedInputWrites, 1);
    assert.equal(runtime.sendCalls[0]!.timeoutMs, 25_000);
    assert.deepEqual(runtime.sendCalls[0]!.args, [
      "terminal",
      "send",
      "--terminal",
      HANDLE,
      "--text",
      "hello",
      "--enter",
      "--wait-submit",
      "15",
      "--json",
    ]);
  }

  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("idle-composer.screen.json");
  runtime.sendFailure = { stdout: "", stderr: "transport failed", exitCode: 1, error: "transport failed" };
  await assert.rejects(
    backend(runtime).submit(currentRef(), "hello", submitContext()),
    (error: unknown) =>
      error instanceof WriteOutcomeUnknown &&
      error.message === "送信できたか確認できません。端末を確かめてください",
  );
  assert.equal(runtime.sendCalls.length, 1, "ambiguous submission must not be resent");
  assert.equal(runtime.acceptedInputWrites, 0);
});
test("Orca classifies unconfirmed sends as outcome-unknown without retrying", async () => {
  const acceptedThenTransport = new FakeOrcaRuntime();
  acceptedThenTransport.screen = capturedClaudeScreen("idle-composer.screen.json");
  acceptedThenTransport.sendFailure = {
    stdout: "",
    stderr: "transport failed",
    exitCode: 1,
    error: "transport failed",
  };
  acceptedThenTransport.sendFailureAfterAccept = true;
  await assert.rejects(
    backend(acceptedThenTransport).submit(currentRef(), "hello", submitContext()),
    WriteOutcomeUnknown,
  );
  assert.equal(acceptedThenTransport.sendCalls.length, 1);
  assert.equal(acceptedThenTransport.acceptedInputWrites, 1);

  const malformedReceipt = new FakeOrcaRuntime();
  malformedReceipt.screen = capturedClaudeScreen("idle-composer.screen.json");
  malformedReceipt.sendFailure = { stdout: "not json", stderr: "", exitCode: 0 };
  malformedReceipt.sendFailureAfterAccept = true;
  await assert.rejects(
    backend(malformedReceipt).submit(currentRef(), "hello", submitContext()),
    WriteOutcomeUnknown,
  );
  assert.equal(malformedReceipt.sendCalls.length, 1);
  assert.equal(malformedReceipt.acceptedInputWrites, 1);

  const unconfirmedReceipt = new FakeOrcaRuntime();
  unconfirmedReceipt.screen = capturedClaudeScreen("idle-composer.screen.json");
  unconfirmedReceipt.sendReceipt = { send: { accepted: false } };
  await assert.rejects(
    backend(unconfirmedReceipt).submit(currentRef(), "hello", submitContext()),
    WriteOutcomeUnknown,
  );
  assert.equal(unconfirmedReceipt.sendCalls.length, 1);
  assert.equal(unconfirmedReceipt.acceptedInputWrites, 0);

  const answerRuntime = new FakeOrcaRuntime();
  answerRuntime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  answerRuntime.sendFailure = failure("runtime_unavailable", "transport failed");
  answerRuntime.sendFailureAfterAccept = true;
  const prompt = capturedQuestion(answerRuntime.screen);
  const channel = backend(answerRuntime).openAnswer(currentRef(), prompt.verified);
  await assert.rejects(channel.digit(1, false), WriteOutcomeUnknown);
  assert.equal(answerRuntime.sendCalls.length, 1);
  assert.equal(answerRuntime.acceptedInputWrites, 1);
  await assert.rejects(channel.digit(1, false), ExpectationLost);
  assert.equal(answerRuntime.sendCalls.length, 1, "the closed channel cannot retry an uncertain write");
});

test("Orca submit checks cancellation before process inspection and at the write boundary", async () => {
  const alreadyCancelled = new FakeOrcaRuntime();
  await assert.rejects(
    backend(alreadyCancelled).submit(currentRef(), "hello", submitContext(() => true)),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "cancelled",
  );
  assert.equal(alreadyCancelled.calls.length, 0);

  const cancelledAtWrite = new FakeOrcaRuntime();
  cancelledAtWrite.screen = capturedClaudeScreen("idle-composer.screen.json");
  const context = submitContext(
    () => cancelledAtWrite.calls.some((call) => call.file === "ps" && call.args[0] === "-axww"),
  );
  await assert.rejects(
    backend(cancelledAtWrite).submit(currentRef(), "hello", context),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "cancelled",
  );
  assert.equal(cancelledAtWrite.sendCalls.length, 0);
  assert.equal(cancelledAtWrite.acceptedInputWrites, 0);
});
test("Orca writes read their terminal and screen before the final process check", async () => {
  const paths = ["submit", "answer", "blind", "composer"] as const;
  const idle = capturedClaudeScreen("idle-composer.screen.json");
  const question = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");

  const write = async (runtime: FakeOrcaRuntime, path: (typeof paths)[number]): Promise<void> => {
    runtime.screen = path === "answer" ? question : idle;
    const terminals = backend(runtime);
    if (path === "submit") {
      await terminals.submit(currentRef(), "hello", submitContext());
    } else if (path === "answer") {
      const prompt = capturedQuestion(runtime.screen);
      await terminals.openAnswer(currentRef(), prompt.verified).digit(1, false);
    } else if (path === "blind") {
      const prompt = claudeDriver.parseBlockedPane("ordinary terminal output");
      if (prompt.kind !== "blind-permission") throw new Error("expected a blind prompt");
      await terminals.openBlind(currentRef(), prompt.blind).answer("y");
    } else {
      await terminals.openComposer(currentRef(), claudeDriver).backTab();
    }
  };

  for (const path of paths) {
    const runtime = new FakeOrcaRuntime();
    await write(runtime, path);
    assertLastWriteOrder(runtime, path);
  }

  for (const switchAt of ["terminal list", "terminal read"] as const) {
    for (const path of paths) {
      const runtime = new FakeOrcaRuntime();
      const original = runtime.processes[0]!;
      const switchProcess = () => {
        runtime.processes = [{ ...original, lstart: "Mon Sep 28 21:00:00 2026" }];
      };
      if (switchAt === "terminal list") runtime.terminalListHook = switchProcess;
      else runtime.screenReadHook = switchProcess;

      await assert.rejects(
        write(runtime, path),
        (error: unknown) =>
          path === "submit"
            ? error instanceof SubmitRefused && error.reason === "agent-changed"
            : error instanceof ExpectationLost,
        `${path} after switch during ${switchAt}`,
      );
      assert.equal(runtime.sendCalls.length, 0, `${path} after switch during ${switchAt}`);
    }
  }
});
test("Orca refuses unsendable C0 input before commands and accepts multiline text", async () => {
  const unsafe = "\u001b[A\r";
  const multiline = "first line\nsecond\tfield";
  const idle = capturedClaudeScreen("idle-composer.screen.json");
  const question = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");

  const unsafeSubmit = new FakeOrcaRuntime();
  unsafeSubmit.screen = idle;
  await assert.rejects(
    backend(unsafeSubmit).submit(currentRef(), unsafe, submitContext()),
    (error: unknown) =>
      error instanceof SubmitRefused &&
      error.reason === "unsafe-text" &&
      error.message.includes("制御文字"),
  );
  assert.equal(unsafeSubmit.calls.length, 0);

  const carriageReturnSubmit = new FakeOrcaRuntime();
  await assert.rejects(
    backend(carriageReturnSubmit).submit(currentRef(), "\r", submitContext()),
    (error: unknown) => error instanceof SubmitRefused && error.reason === "unsafe-text",
  );
  assert.equal(carriageReturnSubmit.calls.length, 0);

  const unsafeAnswer = new FakeOrcaRuntime();
  unsafeAnswer.screen = question;
  const unsafePrompt = capturedQuestion(unsafeAnswer.screen);
  await assert.rejects(
    backend(unsafeAnswer)
      .openAnswer(currentRef(), unsafePrompt.verified)
      .text(unsafe),
    (error: unknown) => error instanceof ExpectationLost && error.userMessage?.includes("制御文字"),
  );
  assert.equal(unsafeAnswer.calls.length, 0);

  const unsafeDriverAnswer = new FakeOrcaRuntime();
  unsafeDriverAnswer.screen = question;
  const driverPrompt = capturedQuestion(unsafeDriverAnswer.screen);
  const terminals = backend(unsafeDriverAnswer);
  await assert.rejects(
    claudeDriver.answerQuestionFreeText!(
      terminals,
      terminals.openAnswer(currentRef(), driverPrompt.verified),
      currentRef(),
      driverPrompt.info,
      unsafe,
    ),
    (error: unknown) => error instanceof ExpectationLost && error.userMessage?.includes("制御文字"),
  );
  assert.equal(unsafeDriverAnswer.calls.length, 0, "unsafe text is rejected before arrow navigation");

  const safeSubmit = new FakeOrcaRuntime();
  safeSubmit.screen = idle;
  await backend(safeSubmit).submit(currentRef(), multiline, submitContext());
  const submittedText = safeSubmit.sendCalls[0]!.args;
  assert.equal(submittedText[submittedText.indexOf("--text") + 1], multiline);
  assertLastWriteOrder(safeSubmit, "multiline submit");

  const safeAnswer = new FakeOrcaRuntime();
  safeAnswer.screen = question;
  const safePrompt = capturedQuestion(safeAnswer.screen);
  await backend(safeAnswer).openAnswer(currentRef(), safePrompt.verified).text(multiline);
  const answeredText = safeAnswer.sendCalls[0]!.args;
  assert.equal(answeredText[answeredText.indexOf("--text") + 1], multiline);
  assertLastWriteOrder(safeAnswer, "multiline answer");
});

test("Orca answer confirmation accepts the captured unnumbered Submit row and writes Enter alone", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
  const prompt = capturedQuestion(capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json"));
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await channel.confirm("Submit", false);

  assert.equal(runtime.sendCalls.length, 1);
  assert.equal(runtime.sendCalls[0]!.args.includes("--enter"), true);
  assert.equal(runtime.sendCalls[0]!.args.includes("--text"), false);
  assert.equal(runtime.sendCalls[0]!.args.some((arg) => arg.includes("\u001b") || arg.includes("\r")), false);
});

test("Orca answer channel batches repeated arrows and never combines them with Enter", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 1) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await channel.move("Down", 4);
  await channel.confirm("Submit", false);

  assert.equal(runtime.sendCalls.length, 2);
  const arrowArgs = runtime.sendCalls[0]!.args;
  assert.equal(arrowArgs[arrowArgs.indexOf("--text") + 1], "\u001b[B".repeat(4));
  assert.equal(arrowArgs.includes("--enter"), false);
  const enterArgs = runtime.sendCalls[1]!.args;
  assert.equal(enterArgs.includes("--text"), false);
  assert.deepEqual(enterArgs.slice(enterArgs.indexOf("--enter")), ["--enter", "--json"]);
  for (const { args } of runtime.sendCalls) {
    const textIndex = args.indexOf("--text");
    const payload = textIndex < 0 ? "" : args[textIndex + 1]!;
    assert.equal(args.includes("--enter") && payload.includes("\u001b"), false);
    assert.equal(payload.includes("\u001b") && payload.includes("\r"), false);
  }
});

test("Orca answer channel skips a second write after the prompt fingerprint changes", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  const prompt = capturedQuestion(runtime.screen);
  runtime.afterSend = () => {
    runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
  };
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await channel.digit(1, false);
  await assert.rejects(channel.digit(3, false), ExpectationLost);

  assert.equal(runtime.sendCalls.length, 1);
  assert.equal(runtime.acceptedInputWrites, 1);
});

test("Orca Claude multi-select sends 1 only after the captured review is verified", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);

  await claudeDriver.answerQuestionMultiSelect!(
    terminals,
    terminals.openAnswer(currentRef(), prompt.verified),
    currentRef(),
    [1, 3],
    prompt.info,
  );

  assert.equal(runtime.sendCalls.length, 5);
  const finalWrite = runtime.sendCalls[4]!.args;
  assert.equal(finalWrite[finalWrite.indexOf("--text") + 1], "1");
  assert.equal(finalWrite.includes("--enter"), false);
  assertLastWriteOrder(runtime, "Q2 review confirmation");
});

test("Orca Claude multi-select refuses incomplete or mismatched reviews without sending 1", async () => {
  const reviewFailure = "確認画面を確かめられなかったので送信していません。端末で確かめてください";
  const invalidReviews: Array<{ name: string; make(): JsonObject }> = [
    {
      name: "missing Cancel",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail.pop();
        return { ...screen, tail };
      },
    },
    {
      name: "wrong heading",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail[tail.indexOf("Ready to submit your answers?")] = "Ready to submit?";
        return { ...screen, tail };
      },
    },
    {
      name: "answer mismatch",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail[tail.indexOf("   → Amber, Jade")] = "   → Amber, Cobalt";
        return { ...screen, tail };
      },
    },
    {
      name: "missing answer list",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = (screen.tail as string[]).filter((row) => !row.trimStart().startsWith("→"));
        return { ...screen, tail };
      },
    },
    {
      name: "incomplete screen",
      make: () => ({
        ...capturedClaudeScreen("ask-user-question-multiselect-review.screen.json"),
        limited: true,
      }),
    },
    {
      name: "cursor on Cancel",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        const submitAt = tail.indexOf("❯ 1. Submit answers");
        tail[submitAt] = "  1. Submit answers";
        tail[submitAt + 1] = "❯ 2. Cancel";
        return { ...screen, tail };
      },
    },
    {
      name: "later question below Cancel",
      make: () => {
        const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
        const tail = [...(screen.tail as string[])];
        tail.push(
          " ☐ Later question",
          "Later question: choose the replacement answer?",
          "❯ 1. Keep",
          "  2. Change",
          "  3. Type something.",
        );
        return { ...screen, tail };
      },
    },
  ];

  for (const invalidReview of invalidReviews) {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
    runtime.afterSend = () => {
      if (runtime.sendCalls.length === 3) {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
      }
      if (runtime.sendCalls.length === 4) runtime.screen = invalidReview.make();
    };
    const prompt = capturedQuestion(runtime.screen);
    const terminals = backend(runtime);
    await assert.rejects(
      claudeDriver.answerQuestionMultiSelect!(
        terminals,
        terminals.openAnswer(currentRef(), prompt.verified),
        currentRef(),
        [1, 3],
        prompt.info,
      ),
      (error: unknown) =>
        error instanceof ExpectationLost &&
        error.message === reviewFailure &&
        error.userMessage === reviewFailure,
      invalidReview.name,
    );
    assert.equal(runtime.sendCalls.length, 4, invalidReview.name);
    assert.equal(runtime.sendCalls[3]!.args.includes("--enter"), true, invalidReview.name);
    assert.equal(runtime.acceptedInputWrites, 4, invalidReview.name);
  }
});
test("Orca rechecks the Submit cursor on the fresh write snapshot", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
    }
  };
  let reviewRead = false;
  runtime.screenReadHook = () => {
    if (reviewRead || !capturedText(runtime.screen).includes("Ready to submit your answers?")) return;
    reviewRead = true;
    const screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
    const tail = [...(screen.tail as string[])];
    const submitAt = tail.indexOf("❯ 1. Submit answers");
    tail[submitAt] = "  1. Submit answers";
    tail[submitAt + 1] = "❯ 2. Cancel";
    runtime.screen = { ...screen, tail };
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);
  await assert.rejects(
    claudeDriver.answerQuestionMultiSelect!(
      terminals,
      terminals.openAnswer(currentRef(), prompt.verified),
      currentRef(),
      [1, 3],
      prompt.info,
    ),
    ExpectationLost,
  );
  assert.equal(runtime.sendCalls.length, 4, "the later Cancel cursor receives no 1");
});

test("Orca Q2 timeout refuses a matching review returned after two seconds", async () => {
  const reviewFailure = "確認画面を確かめられなかったので送信していません。端末で確かめてください";
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const runtime = new FakeOrcaRuntime();
    runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
    runtime.afterSend = () => {
      if (runtime.sendCalls.length === 3) {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
      }
      if (runtime.sendCalls.length === 4) {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
      }
    };
    let delayedRead = false;
    runtime.screenReadHook = () => {
      if (!delayedRead && capturedText(runtime.screen).includes("Ready to submit your answers?")) {
        delayedRead = true;
        now += 2_001;
      }
    };
    const prompt = capturedQuestion(runtime.screen);
    const terminals = backend(runtime);
    await assert.rejects(
      claudeDriver.answerQuestionMultiSelect!(
        terminals,
        terminals.openAnswer(currentRef(), prompt.verified),
        currentRef(),
        [1, 3],
        prompt.info,
      ),
      (error: unknown) =>
        error instanceof ExpectationLost &&
        error.message === reviewFailure &&
        error.userMessage === reviewFailure,
    );
    assert.equal(delayedRead, true);
    assert.equal(runtime.sendCalls.length, 4, "a matching review returned after the deadline receives no 1");
  } finally {
    Date.now = originalNow;
  }
});

test("Orca Claude multi-select never confirms when the review screen does not appear", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      runtime.screen = capturedClaudeScreen("idle-composer.screen.json");
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);
  await assert.rejects(
    claudeDriver.answerQuestionMultiSelect!(
      terminals,
      terminals.openAnswer(currentRef(), prompt.verified),
      currentRef(),
      [1, 3],
      prompt.info,
    ),
    ExpectationLost,
  );
  assert.equal(runtime.sendCalls.length, 4);
  assert.equal(runtime.sendCalls[3]!.args.includes("--enter"), true);
});

test("Orca blind permission sends exactly one y-or-n byte without Enter", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("idle-composer.screen.json");
  const parsed = claudeDriver.parseBlockedPane("ordinary terminal output");
  if (parsed.kind !== "blind-permission") throw new Error("expected a blind permission prompt");
  const channel = backend(runtime).openBlind(currentRef(), parsed.blind);

  await channel.answer("y");
  await assert.rejects(channel.answer("n"), ExpectationLost);

  assert.equal(runtime.sendCalls.length, 1);
  assert.equal(runtime.sendCalls[0]!.args[runtime.sendCalls[0]!.args.indexOf("--text") + 1], "y");
  assert.equal(runtime.sendCalls[0]!.args.includes("--enter"), false);
});

test("Orca composer BackTab is one raw write after process, screen, idle, and draft gates", async () => {
  const idle = () => capturedClaudeScreen("idle-composer.screen.json");
  const runtime = new FakeOrcaRuntime();
  runtime.screen = idle();
  const channel = backend(runtime).openComposer(currentRef(), claudeDriver);
  await channel.backTab();
  await assert.rejects(channel.backTab(), ExpectationLost);
  assert.equal(runtime.sendCalls.length, 1);
  assert.equal(runtime.sendCalls[0]!.args[runtime.sendCalls[0]!.args.indexOf("--text") + 1], "\u001b[Z");
  assert.equal(runtime.sendCalls[0]!.args.includes("--enter"), false);

  const blocked: Array<{ name: string; prepare(runtime: FakeOrcaRuntime): AgentRef }> = [
    {
      name: "changed process",
      prepare: () => {
        const ref = currentRef();
        return { ...ref, processStartedAt: (ref.processStartedAt ?? 0) + 1 };
      },
    },
    {
      name: "incomplete screen",
      prepare: (runtime) => {
        runtime.screen = { ...idle(), limited: true };
        return currentRef();
      },
    },
    {
      name: "non-idle composer",
      prepare: (runtime) => {
        runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
        return currentRef();
      },
    },
    {
      name: "non-empty draft",
      prepare: (runtime) => {
        runtime.screen = { ...idle(), draft: "unsent draft" };
        return currentRef();
      },
    },
  ];
  for (const gate of blocked) {
    const blockedRuntime = new FakeOrcaRuntime();
    blockedRuntime.screen = idle();
    const ref = gate.prepare(blockedRuntime);
    await assert.rejects(backend(blockedRuntime).openComposer(ref, claudeDriver).backTab(), ExpectationLost, gate.name);
    assert.equal(blockedRuntime.sendCalls.length, 0, gate.name);
  }
});

test("Orca does not expose Codex Escape model menus", () => {
  const runtime = new FakeOrcaRuntime();
  assert.throws(() => backend(runtime).openModelAnswer(currentRef(), {} as never), ExpectationLost);
  assert.equal(runtime.sendCalls.length, 0);
});
test("Orca Enter is refused when the captured cursor label does not match", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  const prompt = capturedQuestion(runtime.screen);
  const channel = backend(runtime).openAnswer(currentRef(), prompt.verified);

  await assert.rejects(channel.confirm("Submit", false), ExpectationLost);
  assert.equal(runtime.sendCalls.length, 0);
});

test("Orca multi-select free text verifies its own answer in the review screen", async () => {
  const runtime = new FakeOrcaRuntime();
  runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-before-down.screen.json");
  runtime.afterSend = () => {
    if (runtime.sendCalls.length === 3) {
      runtime.screen = capturedClaudeScreen("ask-user-question-multiselect-submit-row.screen.json");
    }
    if (runtime.sendCalls.length === 4) {
      const review = capturedClaudeScreen("ask-user-question-multiselect-review.screen.json");
      const tail = [...(review.tail as string[])];
      tail[tail.indexOf("   → Amber, Jade")] = "   → Other color";
      runtime.screen = { ...review, tail };
    }
  };
  const prompt = capturedQuestion(runtime.screen);
  const terminals = backend(runtime);

  await claudeDriver.answerQuestionFreeText!(
    terminals,
    terminals.openAnswer(currentRef(), prompt.verified),
    currentRef(),
    prompt.info,
    "Other color",
  );

  assert.equal(runtime.sendCalls.length, 5);
  assert.equal(runtime.sendCalls[4]!.args[runtime.sendCalls[4]!.args.indexOf("--text") + 1], "1");
});
