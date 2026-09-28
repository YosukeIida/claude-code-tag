export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type BackendName = "herdr" | "orca";

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
    readonly reason: "not-idle" | "draft" | "gate" | "incomplete-screen" | "agent-changed" | "cancelled",
    message: string,
  ) {
    super(message);
  }
}

export class ExpectationLost extends Error {}
