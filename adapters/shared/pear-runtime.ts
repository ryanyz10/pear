import {
  ACK_CONTRACT,
  STEERING_CONTRACT,
  buildSummary,
  createCheckpoint,
  type Checkpoint,
} from "../../core/checkpoint.ts";
import type { Mode, PearConfig } from "../../core/config.ts";
import { changedLines, diffText, fileStateHashes, gitOk, quickStateHash } from "../../core/git.ts";
import { runReview, type Complete } from "../../core/llm.ts";
import { createScheduler, type Scheduler, type SchedulerHooks } from "../../core/navigate.ts";
import { formatFindings } from "../../core/review.ts";
import { blockMessage } from "./conversational.ts";

export { ACK_CONTRACT, STEERING_CONTRACT };

export const SUPERSEDED_REASON = "superseded by checkpoint — await new direction";

export const AGENT_DRIVER_PERSONA = `You are pairing with a human. You are the DRIVER; they are the NAVIGATOR — but they are not watching every edit, so checkpoints are how you keep them oriented.
- Before starting a batch of related changes, state the big-picture goal in one or two sentences.
- When a tool result begins with "${STEERING_CONTRACT.trim()}", treat that as new direction and do not assume the superseded call ran.
- When a tool result is exactly "${ACK_CONTRACT}", re-issue the same call unchanged and continue as planned.
- At a checkpoint, restate the goal and what you plan to do next before continuing.
- Re-read files you touched before this turn after any human edit.
- Be succinct.`;

export const HUMAN_DRIVER_PERSONA = `You are pairing with a human who is driving. Messages tagged "pear-nav" are informational findings from a background reviewer of the human's own uncommitted changes — they are not directed at you. Act on them only if the human asks you to.`;

export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export type ReviewCompletions = {
  small: Complete | null;
  large: Complete | null;
};

export type PearUi = {
  hasUI: boolean;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus: (key: string, text: string | undefined) => void;
};

export type PearDeps = {
  cwd: string;
  cfg: Required<PearConfig>;
  completions: ReviewCompletions;
  ui: PearUi;
  onFindings: (text: string) => void;
  sendUserMessage: (text: string) => void;
  saveConfig: (patch: Partial<PearConfig>) => void;
  /** Optional overrides for tests. */
  gitOk?: (cwd: string) => boolean;
  changedLines?: (cwd: string) => number;
  diffText?: (cwd: string) => string;
  quickStateHash?: (cwd: string) => string;
  fileStateHashesFn?: (cwd: string) => Map<string, string>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
};

export type ToolCallLike = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ToolCallDecision =
  | { block: true; reason: string }
  | undefined;

export type PearSession = {
  isGit: boolean;
  mode: Mode;
  scheduler: Scheduler | null;
  checkpoint: Checkpoint | null;
  start: () => void;
  stop: () => void;
  setMode: (mode: Mode, cfg: Required<PearConfig>, completions: ReviewCompletions) => void;
  statusText: () => string;
  onToolCall: (event: ToolCallLike) => Promise<ToolCallDecision>;
  onToolResult: (toolCallId: string, isError: boolean) => void;
  onTurnEnd: () => void;
  onAgentStart: () => void;
  onAgentEnd: () => Promise<void>;
  personaSystemPrompt: (base: string) => string;
};

export type ModelPickerUi = {
  select: (title: string, choices: string[]) => Promise<string | undefined>;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
};

const MODELS_NEEDED_REASON = "human-driver needs reviewModel and filterModel set — run /pear-config first";

/**
 * Resolves whether `mode`'s model requirements are satisfiable. `agent-driver`
 * and `off` have none. `human-driver` requires both `reviewModel` and
 * `filterModel` to be in `availableModels`; with UI it prompts for whichever
 * is missing, headless fails with a clear reason. No filesystem side effect —
 * the caller persists the returned patch.
 */
export async function ensureModelsConfigured(
  mode: Mode,
  cfg: Required<PearConfig>,
  ui: ModelPickerUi,
  availableModels: string[],
  hasUI: boolean,
): Promise<{ ok: true; patch: Partial<PearConfig> } | { ok: false; reason: string }> {
  if (mode !== "human-driver") return { ok: true, patch: {} };

  const needsReview = !cfg.reviewModel;
  const needsFilter = !cfg.filterModel;
  if (!needsReview && !needsFilter) return { ok: true, patch: {} };
  if (!hasUI) return { ok: false, reason: MODELS_NEEDED_REASON };

  const patch: Partial<PearConfig> = {};
  if (needsReview) {
    const choice = await ui.select(
      "Pick pear's review model (generates findings on your uncommitted changes):",
      availableModels,
    );
    if (choice === undefined) return { ok: false, reason: MODELS_NEEDED_REASON };
    patch.reviewModel = choice;
  }
  if (needsFilter) {
    const choice = await ui.select(
      "Pick pear's filter model (checks the review model's findings before they reach you):",
      availableModels,
    );
    if (choice === undefined) return { ok: false, reason: MODELS_NEEDED_REASON };
    patch.filterModel = choice;
  }
  return { ok: true, patch };
}

function toolLabel(event: ToolCallLike): string {
  const input = event.input;
  if (event.toolName === "bash") {
    return `bash ${String(input.command ?? "").slice(0, 80)}`;
  }
  if (typeof input.path === "string") return `${event.toolName} ${input.path}`;
  return event.toolName;
}

export function createPearSession(deps: PearDeps): PearSession {
  const cwd = deps.cwd;
  const gitOkFn = deps.gitOk ?? gitOk;
  const linesFn = deps.changedLines ?? changedLines;
  const diffFn = deps.diffText ?? diffText;
  const quickHashFn = deps.quickStateHash ?? quickStateHash;
  const fileHashesFn = deps.fileStateHashesFn ?? fileStateHashes;
  const nowFn = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = deps.clearTimeout ?? ((id) => clearTimeout(id as NodeJS.Timeout));
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;

  const isGit = gitOkFn(cwd);

  let mode: Mode = "off";
  let cfg: Required<PearConfig> = deps.cfg;
  let checkpoint: Checkpoint | null = null;
  let scheduler: Scheduler | null = null;
  let pollTimer: unknown = null;
  let suppressMutations = false;
  let started = false;

  const safeFileHashes = (): Map<string, string> => {
    if (!isGit) return new Map();
    try {
      return fileHashesFn(cwd);
    } catch {
      return new Map();
    }
  };

  const statusText = (): string => {
    if (mode === "off") return "pear: off — /pear-mode to start";
    if (mode === "agent-driver" && checkpoint) {
      const snap = checkpoint.snapshot();
      const elapsedS = Math.floor((nowFn() - snap.baselineTime) / 1000);
      return `pear: agent-driver | ${elapsedS}s/${cfg.checkpointSeconds}s, ${snap.confirmed + snap.pending}/${cfg.maxChangesPerCheckpoint} changes`;
    }
    if (mode === "human-driver" && scheduler) {
      return `pear: human-driver | ${scheduler.getState().toLowerCase()} | last: ${scheduler.getLastSummary()}`;
    }
    return `pear: ${mode}`;
  };

  const refreshStatus = () => {
    if (!deps.ui.hasUI) return;
    try {
      deps.ui.setStatus("pear-nav", statusText());
    } catch {
      /* best-effort */
    }
  };

  const startPoll = () => {
    if (pollTimer != null || mode !== "human-driver" || !scheduler) return;
    pollTimer = setIntervalFn(() => {
      if (!scheduler) return;
      try {
        scheduler.notify(quickHashFn(cwd));
        refreshStatus();
      } catch {
        /* transient git error: skip tick */
      }
    }, 2000);
  };

  const stopPoll = () => {
    if (pollTimer != null) {
      clearIntervalFn(pollTimer as NodeJS.Timeout);
      pollTimer = null;
    }
  };

  const buildScheduler = (
    c: Required<PearConfig>,
    completeSmall: Complete,
    completeLarge: Complete,
  ): Scheduler => {
    const hooks: SchedulerHooks = {
      now: nowFn,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      getChangedLines: () => linesFn(cwd),
      getDiffText: () => diffFn(cwd),
      runReview: async (diff) => {
        try {
          const { kept, filtered } = await runReview(completeSmall, completeLarge, diff);
          deps.onFindings(formatFindings(kept, filtered));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      onOutput: (text) => {
        if (deps.ui.hasUI) {
          try {
            deps.ui.notify(text.trim(), "error");
          } catch {
            /* best-effort */
          }
        }
      },
    };
    return createScheduler(
      { minLines: c.minLines, intervalSeconds: c.intervalSeconds, debounceSeconds: c.debounceSeconds },
      hooks,
    );
  };

  const setMode = (newMode: Mode, newCfg: Required<PearConfig>, completions: ReviewCompletions) => {
    stopPoll();
    scheduler?.stop();
    scheduler = null;
    checkpoint = null;
    cfg = newCfg;

    if (newMode === "agent-driver") {
      mode = "agent-driver";
      checkpoint = createCheckpoint(
        { checkpointSeconds: cfg.checkpointSeconds, maxChangesPerCheckpoint: cfg.maxChangesPerCheckpoint },
        nowFn(),
        safeFileHashes(),
      );
    } else if (newMode === "human-driver") {
      if (!isGit || !completions.small || !completions.large) {
        mode = "off";
      } else {
        mode = "human-driver";
        scheduler = buildScheduler(cfg, completions.small, completions.large);
      }
    } else {
      mode = "off";
    }

    if (started && mode === "human-driver") startPoll();
    refreshStatus();
  };

  const start = () => {
    started = true;
    startPoll();
    refreshStatus();
  };

  const stop = () => {
    started = false;
    stopPoll();
    scheduler?.stop();
  };

  const onToolCall = async (event: ToolCallLike): Promise<ToolCallDecision> => {
    if (mode !== "agent-driver" || !checkpoint) return undefined;
    if (!MUTATING_TOOLS.has(event.toolName)) return undefined;

    if (suppressMutations) {
      return { block: true, reason: SUPERSEDED_REASON };
    }

    if (!checkpoint.check(nowFn())) {
      checkpoint.reserve(event.toolCallId);
      return undefined;
    }

    if (!deps.ui.hasUI) {
      // Headless: allow without reserving.
      return undefined;
    }

    const snap = checkpoint.snapshot();
    const summary = buildSummary(
      toolLabel(event),
      { elapsedMs: nowFn() - snap.baselineTime, changes: snap.confirmed + snap.pending },
      checkpoint.filesSinceBaseline(safeFileHashes()),
    );

    // Never await a human inside a tool_call — decide synchronously, latch the
    // rest of the batch, and route the actual review to the chat turn.
    suppressMutations = true;
    checkpoint.resetBaseline(nowFn(), safeFileHashes());
    try {
      deps.ui.notify(summary, "warning");
    } catch {
      /* best-effort surfacing; the returned block still carries the summary */
    }
    return { block: true, reason: STEERING_CONTRACT + blockMessage(summary) };
  };

  const onToolResult = (toolCallId: string, isError: boolean) => {
    if (mode !== "agent-driver" || !checkpoint) return;
    checkpoint.settle(toolCallId, !isError);
  };

  const onTurnEnd = () => {
    suppressMutations = false;
  };

  const onAgentStart = () => {
    suppressMutations = false;
    refreshStatus();
  };

  const onAgentEnd = async () => {
    if (mode !== "agent-driver" || !checkpoint) return;
    try {
      if (deps.ui.hasUI && checkpoint.check(nowFn())) {
        const snap = checkpoint.snapshot();
        const summary = buildSummary(
          "end of turn",
          { elapsedMs: nowFn() - snap.baselineTime, changes: snap.confirmed + snap.pending },
          checkpoint.filesSinceBaseline(safeFileHashes()),
        );
        try {
          // agent_end has the same host deadline as tool_call; never await UI.
          deps.ui.notify(summary, "warning");
        } finally {
          checkpoint.resetBaseline(nowFn(), safeFileHashes());
        }
      }
    } catch {
      /* headless or UI failure: cleanup below still runs */
    } finally {
      refreshStatus();
    }
  };

  setMode(deps.cfg.mode, deps.cfg, deps.completions);

  return {
    isGit,
    get mode() {
      return mode;
    },
    get scheduler() {
      return scheduler;
    },
    get checkpoint() {
      return checkpoint;
    },
    start,
    stop,
    setMode,
    statusText,
    onToolCall,
    onToolResult,
    onTurnEnd,
    onAgentStart,
    onAgentEnd,
    personaSystemPrompt: (base) => {
      if (mode === "agent-driver") return `${base}\n\n${AGENT_DRIVER_PERSONA}`;
      if (mode === "human-driver") return `${base}\n\n${HUMAN_DRIVER_PERSONA}`;
      return base;
    },
  };
}
