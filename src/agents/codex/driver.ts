import type { AnswerChannel, Terminals } from "../../backend/index.js";
import type { AgentInfo } from "../../backend/types.js";
import { promptFingerprint } from "../fingerprint.js";
import type { AgentDriver, BlockedPrompt } from "../driver.js";
import {
  createBlindPermissionPrompt,
  createVerifiedModelMenuPrompt,
  createVerifiedPrompt,
} from "../../backend/prompt.js";
import type { VerifiedModelMenuPrompt } from "../../backend/prompt.js";
import {
  effortLevelKey,
  findCursorRowNum,
  isModelListScreen,
  isEffortListScreen,
  modelNameKey,
  parseCodexMenu,
  parseCodexStartupPrompt,
  parseCursorLabel as parseCodexCursorLabel,
} from "./prompts.js";
import {
  extractCodexLifecycle,
  extractCodexTurnOutput,
  locateCodexTranscript,
  type CodexRecord,
} from "./transcript.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Moves the cursor to `targetNum` via Up/Down arrow presses (computed from
 * the cursor row visible in `paneText`) and confirms with Enter — NOT by
 * typing the row's digit. Verified empirically: typing a digit on Codex's
 * `/model` list screens acts as a combined "jump + confirm", which races
 * through to silently apply a default on whatever screen comes next (e.g.
 * the reasoning-level screen) before the driver can read and answer it.
 * Arrow keys only move the cursor, leaving Enter as the sole confirm.
 */
async function selectRowViaArrows(
  channel: AnswerChannel,
  paneText: string,
  targetNum: string,
  expectedLabel: string,
): Promise<boolean> {
  const current = findCursorRowNum(paneText);
  if (current === null) return false;
  const delta = parseInt(targetNum, 10) - current;
  const key = delta > 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(delta); i++) {
    await channel.move(key, 1);
    await sleep(150);
  }
  await channel.confirm(expectedLabel);
  return true;
}

const LEVEL_ALIASES: Record<string, string> = {
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  extra: "extra high",
  "extrahigh": "extra high",
  "extra-high": "extra high",
  "extra high": "extra high",
};

/** Splits `argsText` into an optional trailing reasoning-level phrase
 *  ("high", "extra high", ...) and the remaining model-name query words —
 *  levels are matched as a 2-word phrase first ("extra high") so it isn't
 *  mistaken for a 1-word level ("high") with "extra" left dangling in the
 *  model query. */
function splitModelAndLevel(words: string[]): { levelKey: string | null; modelWords: string[] } {
  if (words.length >= 3) {
    const phrase = words.slice(-2).join(" ").toLowerCase();
    const alias = LEVEL_ALIASES[phrase];
    if (alias) return { levelKey: alias, modelWords: words.slice(0, -2) };
  }
  if (words.length >= 2) {
    const last = words[words.length - 1].toLowerCase();
    const alias = LEVEL_ALIASES[last];
    if (alias) return { levelKey: alias, modelWords: words.slice(0, -1) };
  }
  return { levelKey: null, modelWords: words };
}

export const codexDriver: AgentDriver = {
  kind: "codex",
  displayName: "Codex CLI",
  readRegion: "screen",

  locateTranscript(cwd, sessionId) {
    return locateCodexTranscript(cwd, sessionId);
  },

  extractTurnOutput(records) {
    const r = records as CodexRecord[];
    return { ...extractCodexTurnOutput(r), lifecycle: extractCodexLifecycle(r) };
  },

  parseStartupPrompt: parseCodexStartupPrompt,

  parseBlockedPane(paneText): BlockedPrompt {
    // Codex has no AskUserQuestion-equivalent tool and no plan mode — every
    // blocked prompt is a command-approval (or directory-trust) menu.
    const menu = parseCodexMenu(paneText);
    if (!menu) {
      return { kind: "blind-permission", blind: createBlindPermissionPrompt(codexDriver) };
    }
    const content = { kind: "permission" as const, menu, isPlanPrompt: false };
    const fingerprint = promptFingerprint(content);
    if (fingerprint === null) {
      return { kind: "blind-permission", blind: createBlindPermissionPrompt(codexDriver) };
    }
    return {
      ...content,
      verified: createVerifiedPrompt(fingerprint, codexDriver, "digit-then-enter"),
    };
  },
  parseCursorLabel(snap) {
    return snap.complete ? parseCodexCursorLabel(snap.text) : null;
  },

  async answerOption(channel, value, expectedLabel) {
    // Verified empirically: unlike Claude Code's permission menu (digit
    // alone submits), Codex's approval/trust/model menus show "Press enter
    // to confirm" — the digit only moves the cursor, Enter is required.
    await channel.digit(Number(value));
    await sleep(150);
    await channel.confirm(expectedLabel);
  },

  // No answerQuestionFreeText / answerPlanFeedback / resolvePlanFile — Codex
  // has no AskUserQuestion tool and no plan-file concept.

  modes: null, // no Shift+Tab ring, no plan mode

  async runModelCommand(terminals, agent, argsText) {
    const words = argsText.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return "⚠️ モデル名を指定してください（例: `model gpt-5.6-sol high`）。";
    }
    const { levelKey, modelWords } = splitModelAndLevel(words);
    const modelQuery = modelWords.join(" ").toLowerCase();
    if (!modelQuery) {
      return "⚠️ モデル名を指定してください。";
    }

    // Atomic submit (see TurnEngine.startTurn) — avoids the send-text/Enter
    // paste race that can leave "/model" sitting unsent in the composer.
    await terminals.submit(agent.ref, "/model", {
      driver: codexDriver,
      cancelled: () => false,
      transcriptGrew: () => false,
      retryLimit: 0,
      pollIntervalMs: 0,
    });
    await sleep(600);

    const stage1Text = (await terminals.read(agent.ref.target, 30, "screen")).text;
    const stage1 = parseCodexMenu(stage1Text);
    if (!stage1) {
      return "⚠️ モデル選択メニューを開けませんでした。";
    }
    const firstPrompt = parseCodexModelMenuPrompt(stage1Text);
    if (!firstPrompt) {
      return "⚠️ モデル選択メニューを開けませんでした。";
    }
    const firstChannel = terminals.openModelAnswer(agent.ref, firstPrompt);

    const match = stage1.choices.find((c) => c.label.toLowerCase().includes(modelQuery));
    if (!match) {
      await firstChannel.escape();
      const candidates = stage1.choices.map((c) => modelNameKey(c.label)).join(", ");
      return `⚠️ モデル「${modelQuery}」が見つかりません。候補: ${candidates}`;
    }
    const modelName = modelNameKey(match.label);

    if (!(await selectRowViaArrows(firstChannel, stage1Text, match.num, match.label))) {
      return "⚠️ モデル選択メニューのカーソル位置を判別できませんでした。";
    }
    await sleep(500);

    const stage2Text = (await terminals.read(agent.ref.target, 30, "screen")).text;
    if (!isEffortListScreen(stage2Text)) {
      // Some models apply immediately with no separate effort screen —
      // the model change (with whatever default effort) is already done.
      return `✅ モデルを ${modelName} に切り替えました。`;
    }
    const stage2 = parseCodexMenu(stage2Text);
    if (!stage2) {
      return `✅ モデルを ${modelName} に切り替えました（推論レベル画面を解析できませんでした）。`;
    }
    const secondPrompt = parseCodexModelMenuPrompt(stage2Text);
    if (!secondPrompt) {
      return `✅ モデルを ${modelName} に切り替えました（推論レベル画面を解析できませんでした）。`;
    }
    const secondChannel = terminals.openModelAnswer(agent.ref, secondPrompt);

    if (!levelKey) {
      // No level requested — accept whatever's pre-highlighted (current/default).
      const selectedLabel = codexDriver.parseCursorLabel({
        text: stage2Text,
        draft: null,
        complete: true,
      });
      if (selectedLabel === null) {
        return `⚠️ モデルを ${modelName} に切り替えましたが、推論レベル画面のカーソル位置を判別できませんでした。`;
      }
      await secondChannel.confirm(selectedLabel);
      return `✅ モデルを ${modelName} に切り替えました。`;
    }

    const levelMatch = stage2.choices.find((c) => effortLevelKey(c.label) === levelKey);
    if (!levelMatch) {
      await secondChannel.escape();
      const candidates = stage2.choices.map((c) => effortLevelKey(c.label)).join(", ");
      return `⚠️ ${modelName} には「${levelKey}」レベルがありません。候補: ${candidates}`;
    }
    if (!(await selectRowViaArrows(secondChannel, stage2Text, levelMatch.num, levelMatch.label))) {
      return `⚠️ モデルを ${modelName} に切り替えましたが、推論レベル画面のカーソル位置を判別できませんでした。`;
    }
    return `✅ モデルを ${modelName} (${effortLevelKey(levelMatch.label)}) に切り替えました。`;
  },
};

export function parseCodexModelMenuPrompt(paneText: string): VerifiedModelMenuPrompt | null {
  if (!isModelListScreen(paneText) && !isEffortListScreen(paneText)) return null;
  const menu = parseCodexMenu(paneText);
  if (!menu) return null;
  const fingerprint = promptFingerprint({ kind: "permission" as const, menu, isPlanPrompt: false });
  return fingerprint === null ? null : createVerifiedModelMenuPrompt(fingerprint, codexDriver);
}
