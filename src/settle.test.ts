import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SettleTracker } from "./settle.js";
import { extractLifecycle } from "./agents/claude/transcript.js";
import { extractCodexLifecycle } from "./agents/codex/transcript.js";

// --- the tracker itself -----------------------------------------------------

test("a completion only counts once a start has been seen", () => {
  // The guard that makes a stale boundary harmless: TurnEngine rewinds to
  // offset 0 when it resolves a transcript mid-turn, so the first records
  // handed over can belong to a *previous* turn.
  const t = new SettleTracker();
  t.observe([{ kind: "completed" }]);
  assert.equal(t.settledByTranscript, false, "a completion with no start is a leftover, not this turn");
  assert.equal(t.effectiveStatus("working"), "working");

  t.observe([{ kind: "started" }, { kind: "completed" }]);
  assert.equal(t.settledByTranscript, true);
  assert.equal(t.effectiveStatus("working"), "idle");
});

test("a pane herdr reports as working is left alone until the transcript closes the turn", () => {
  // The load-bearing property. A real 40-minute turn produces a start and then
  // nothing but tool traffic; declaring it finished would release the pane, let
  // the watcher rebaseline, and drop the output.
  const t = new SettleTracker();
  t.observe([{ kind: "started" }]);
  for (let i = 0; i < 500; i++) t.observe([]); // polls with no new boundary
  assert.equal(t.settledByTranscript, false);
  assert.equal(t.effectiveStatus("working"), "working", "silence is not completion");
});

test("blocked is never rewritten, even after the transcript closed a turn", () => {
  // A pending prompt is deliberately absent from the transcript until answered,
  // so the transcript can never be evidence against a blocked pane — and the
  // prompt-adoption path keys on exactly this status.
  const t = new SettleTracker();
  t.observe([{ kind: "started" }, { kind: "completed" }]);
  assert.equal(t.effectiveStatus("blocked"), "blocked");
});

test("statuses other than working pass through untouched", () => {
  const t = new SettleTracker();
  t.observe([{ kind: "started" }, { kind: "completed" }]);
  assert.equal(t.effectiveStatus("idle"), "idle");
  assert.equal(t.effectiveStatus("done"), "done");
  assert.equal(t.effectiveStatus("unknown"), "unknown");
});

test("a new start re-arms the tracker for the next turn", () => {
  // The watcher's tracker outlives a single turn, so a settled one must not
  // stay settled once the next terminal-side turn begins.
  const t = new SettleTracker();
  t.observe([{ kind: "started" }, { kind: "completed" }]);
  assert.equal(t.effectiveStatus("working"), "idle");
  t.observe([{ kind: "started" }]);
  assert.equal(t.effectiveStatus("working"), "working", "the next turn is running again");
});

test("an adopted pane settles on the completion it was handed mid-turn", () => {
  // Its start predates the handoff's offset, so without markTurnRunning the
  // completion that eventually arrives would be ignored and an adopted turn on
  // a stuck-working pane would never finalize.
  const t = new SettleTracker();
  t.markTurnRunning();
  t.observe([{ kind: "completed" }]);
  assert.equal(t.effectiveStatus("working"), "idle");
});

test("an aborted turn settles too", () => {
  const t = new SettleTracker();
  t.observe([{ kind: "started" }, { kind: "aborted" }]);
  assert.equal(t.effectiveStatus("working"), "idle");
});

// --- Claude Code boundary extraction ---------------------------------------

const userMsg = { type: "user", message: { role: "user", content: "やって" } };
const toolResult = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
};
const assistantWith = (stop: string | null, blocks: unknown[]) => ({
  type: "assistant",
  message: { role: "assistant", stop_reason: stop, content: blocks },
});
const turnDuration = { type: "system", subtype: "turn_duration", durationMs: 2737 };

test("turn_duration is a completion", () => {
  assert.deepEqual(extractLifecycle([turnDuration]), [{ kind: "completed" }]);
});

test("a real user message starts a turn but a tool_result does not", () => {
  // Tool results come back as `user` records too; treating them as starts would
  // re-arm the tracker on every tool call in the turn.
  assert.deepEqual(extractLifecycle([userMsg]), [{ kind: "started" }]);
  assert.deepEqual(extractLifecycle([toolResult]), []);
});

test("a text block emitted alongside tool calls is not a completion", () => {
  // The stop_reason belongs to the API response, not the block, so a response
  // that ends in tool calls stamps `tool_use` on its text block too. This is
  // what keeps the fallback from firing mid-turn.
  assert.deepEqual(
    extractLifecycle([assistantWith("tool_use", [{ type: "text", text: "調べます" }, { type: "tool_use", id: "t1" }])]),
    [],
  );
});

test("an interrupted response is not a completion", () => {
  assert.deepEqual(extractLifecycle([assistantWith(null, [{ type: "text", text: "途中" }])]), []);
});

test("one response split across content blocks yields repeated completions, which settle the same as one", () => {
  // Measured in production: a reply with a thinking block and a text block
  // writes two records, both stamped end_turn. Idempotent for settling.
  const events = extractLifecycle([
    userMsg,
    assistantWith("end_turn", [{ type: "thinking" }]),
    assistantWith("end_turn", [{ type: "text", text: "できました" }]),
    turnDuration,
  ]);
  assert.deepEqual(events, [
    { kind: "started" },
    { kind: "completed" },
    { kind: "completed" },
    { kind: "completed" },
  ]);
  const t = new SettleTracker();
  t.observe(events);
  assert.equal(t.effectiveStatus("working"), "idle");
});

// The records /compact (Claude Code 2.1.287) and /model (2.1.285) write: record
// order and keys are copied from real interactive transcripts (2026-10-02); all
// text is replaced by placeholders except each string's leading tag and the
// first words of the stdout, and timestamps are normalized.
function localCommandFixture(name: string) {
  return readFileSync(new URL(`./agents/claude/__fixtures__/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("a local command's stdout record completes the turn it started", () => {
  for (const name of ["claude-compact.jsonl", "claude-model.jsonl"]) {
    const events = extractLifecycle(localCommandFixture(name));
    assert.deepEqual(events.at(-1), { kind: "completed" }, name);
    assert.ok(events.slice(0, -1).every((e) => e.kind === "started"), `${name}: every earlier string user record is a start`);
  }
});

test("a prompt-type slash command still ends only on the assistant's reply", () => {
  const command = {
    type: "user",
    message: { role: "user", content: "<command-message>skill</command-message>\n<command-name>/skill</command-name>" },
  };
  assert.deepEqual(extractLifecycle([command]), [{ kind: "started" }]);
  assert.deepEqual(extractLifecycle([command, assistantWith("end_turn", [{ type: "text", text: "done" }])]), [
    { kind: "started" },
    { kind: "completed" },
  ]);
});

test("herdr's status after a local command: working settles, blocked is left alone", () => {
  const t = new SettleTracker();
  t.observe(extractLifecycle(localCommandFixture("claude-compact.jsonl")));
  assert.equal(t.effectiveStatus("working"), "idle");
  assert.equal(t.effectiveStatus("idle"), "idle");
  assert.equal(t.effectiveStatus("blocked"), "blocked");
});

test("stop_sequence and max_tokens end a turn as well", () => {
  assert.deepEqual(extractLifecycle([assistantWith("stop_sequence", [])]), [{ kind: "completed" }]);
  assert.deepEqual(extractLifecycle([assistantWith("max_tokens", [])]), [{ kind: "completed" }]);
});

test("subagent records never arm or settle the pane's turn", () => {
  // A sidechain's turns are not the pane's turn; reporting one as the pane's
  // completion would finalize a turn that is still running.
  const events = extractLifecycle([
    { ...userMsg, isSidechain: true },
    { ...turnDuration, isSidechain: true },
    { ...assistantWith("end_turn", []), isSidechain: true },
  ]);
  assert.deepEqual(events, []);
});

// --- Codex boundary extraction ---------------------------------------------

test("Codex task_started/task_complete carry their turn id", () => {
  const events = extractCodexLifecycle([
    { type: "event_msg", payload: { type: "task_started", turn_id: "T1" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "T1" } },
  ]);
  assert.deepEqual(events, [
    { kind: "started", turnId: "T1" },
    { kind: "completed", turnId: "T1" },
  ]);
});

test("Codex turn_aborted ends a turn", () => {
  assert.deepEqual(extractCodexLifecycle([{ type: "event_msg", payload: { type: "turn_aborted", turn_id: "T2" } }]), [
    { kind: "aborted", turnId: "T2" },
  ]);
});

test("Codex agent_message is not a boundary", () => {
  // It duplicates assistant text that extractCodexTurnOutput already reads from
  // response_item records — reading it here would be noise, and reading it
  // there would double-post.
  assert.deepEqual(
    extractCodexLifecycle([
      { type: "event_msg", payload: { type: "agent_message" } },
      { type: "event_msg", payload: { type: "token_count" } },
      { type: "response_item", payload: { type: "message", role: "assistant" } },
    ]),
    [],
  );
});
