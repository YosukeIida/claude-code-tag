import type { BlindPermissionPrompt, VerifiedModelMenuPrompt, VerifiedPrompt } from "./prompt.js";
import type { AgentDriver } from "../agents/driver.js";
import { BackendUnavailable, type AgentInfo, type AgentRef, type ListResult, type ScreenSnapshot, UnknownTarget } from "./types.js";

export * from "./types.js";

export type SubmitOutcome = "started" | "accepted";

export interface SubmitContext {
  driver: AgentDriver;
  cancelled(): boolean;
  transcriptGrew(): boolean | null;
  /** Herdr's existing image-upload retry budget; ordinary prompts use one poll. */
  retryLimit: number;
  /** The poll interval already used by TurnEngine before moving submit here. */
  pollIntervalMs: number;
}

export interface AnswerChannel {
  digit(n: number, terminal?: boolean): Promise<void>;
  text(value: string): Promise<void>;
  move(direction: "Up" | "Down", count: number): Promise<void>;
  confirm(expectedLabel: string, terminal?: boolean): Promise<void>;
  /** Close after the driver has observed that its final write completed the answer. */
  complete(): void;
}

/** The `/model` menu channel; Escape is not exposed on ordinary answers. */
export interface ModelAnswerChannel extends AnswerChannel {
  escape(): Promise<void>;
}

export interface BlindChannel {
  answer(choice: "y" | "n"): Promise<void>;
}

export interface ComposerChannel {
  backTab(): Promise<void>;
}

export interface Terminals {
  list(): Promise<ListResult>;
  get(target: string): Promise<AgentInfo | null>;
  exists(target: string): Promise<boolean>;
  read(target: string, lines: number, region: "screen" | "history"): Promise<ScreenSnapshot>;
  submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome>;
  openAnswer(ref: AgentRef, prompt: VerifiedPrompt): AnswerChannel;
  openModelAnswer(ref: AgentRef, prompt: VerifiedModelMenuPrompt): ModelAnswerChannel;
  openBlind(ref: AgentRef, prompt: BlindPermissionPrompt): BlindChannel;
  openComposer(ref: AgentRef, driver: AgentDriver): ComposerChannel;
}

function noOrcaBackend(target: string): never {
  throw new UnknownTarget(`No Orca backend is available for target ${target}`);
}

function collisionMessage(agent: AgentInfo): string {
  return `herdr target collision: reserved orca: namespace returned as ${agent.ref.target}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Routes the current herdr-only backend surface without rewriting existing herdr target IDs. */
export function createTerminals(herdr: Terminals): Terminals {
  const herdrFor = (target: string): Terminals => (target.startsWith("orca:") ? noOrcaBackend(target) : herdr);

  return {
    async list(): Promise<ListResult> {
      let result: ListResult;
      try {
        result = await herdr.list();
      } catch (err) {
        return {
          agents: [],
          failures: [{ backend: "herdr", reason: errorMessage(err) }],
          complete: false,
          notices: [],
        };
      }
      const collision = result.agents.find((agent) => agent.ref.target.startsWith("orca:"));
      if (!collision) return result;
      return {
        ...result,
        agents: result.agents.filter((agent) => !agent.ref.target.startsWith("orca:")),
        failures: [...result.failures, { backend: "herdr", reason: collisionMessage(collision) }],
        complete: false,
      };
    },
    async get(target: string): Promise<AgentInfo | null> {
      const agent = await herdrFor(target).get(target);
      if (agent?.ref.target.startsWith("orca:")) throw new BackendUnavailable(collisionMessage(agent));
      return agent;
    },
    exists(target: string): Promise<boolean> {
      return herdrFor(target).exists(target);
    },
    read(target: string, lines: number, region: "screen" | "history"): Promise<ScreenSnapshot> {
      return herdrFor(target).read(target, lines, region);
    },
    submit(ref: AgentRef, text: string, ctx: SubmitContext): Promise<SubmitOutcome> {
      return herdrFor(ref.target).submit(ref, text, ctx);
    },
    openAnswer(ref: AgentRef, prompt: VerifiedPrompt) {
      return herdrFor(ref.target).openAnswer(ref, prompt);
    },
    openModelAnswer(ref: AgentRef, prompt: VerifiedModelMenuPrompt) {
      return herdrFor(ref.target).openModelAnswer(ref, prompt);
    },
    openBlind(ref: AgentRef, prompt: BlindPermissionPrompt) {
      return herdrFor(ref.target).openBlind(ref, prompt);
    },
    openComposer(ref: AgentRef, driver: AgentDriver) {
      return herdrFor(ref.target).openComposer(ref, driver);
    },
  };
}
