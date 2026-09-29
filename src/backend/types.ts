export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type BackendName = "herdr" | "orca";
export const WRITE_OUTCOME_UNKNOWN_MESSAGE = "送信できたか確認できません。端末を確かめてください";
export const UNSENDABLE_TEXT_MESSAGE = "入力に送信できない制御文字が含まれています。制御文字を除いてください。";

const UNSENDABLE_C0_CONTROL = /[\u0000-\u0008\u000B-\u001F]/u;

export function hasUnsendableC0Controls(value: string): boolean {
  return UNSENDABLE_C0_CONTROL.test(value);
}

export type StatusEvidence =
  | { kind: "classified"; status: AgentStatus }
  | { kind: "hint"; state: "working" | "waiting" | "done" | null; waitingSince: number | null };

export interface AgentRef {
  readonly target: string;
  readonly pid: number | null;
  readonly processStartedAt: number | null;
}

export interface AgentInfo {
  ref: AgentRef;
  backend: BackendName;
  agent: "claude" | "codex";
  sessionId: string | null;
  cwd: string;
  evidence: StatusEvidence;
  terminalTitle: string | null;
  /** Display/debug snapshot from the backend; may go stale and never addresses a terminal. */
  terminalId: string;
  displayId: string;
}

export interface ScreenSnapshot {
  text: string;
  draft: string | null;
  complete: boolean;
}

export interface ListResult {
  agents: AgentInfo[];
  failures: { backend: BackendName; reason: string }[];
  complete: boolean;
  notices: string[];
}

export class UnknownTarget extends Error {}
export class BackendUnavailable extends Error {}

export class SubmitRefused extends Error {
  constructor(
    readonly reason: "not-idle" | "draft" | "gate" | "incomplete-screen" | "agent-changed" | "cancelled" | "unsafe-text",
    message: string,
  ) {
    super(message);
  }
}

export class ExpectationLost extends Error {
  constructor(
    message: string,
    readonly userMessage?: string,
  ) {
    super(message);
  }
}
export class WriteOutcomeUnknown extends Error {
  constructor(cause?: unknown) {
    super(WRITE_OUTCOME_UNKNOWN_MESSAGE, cause === undefined ? undefined : { cause });
  }
}
