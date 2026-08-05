import {
  ACK_CONTRACT,
  STEERING_CONTRACT,
  buildSummary,
  createCheckpoint,
  type Checkpoint,
} from "../../core/checkpoint.ts";
import { DEFAULTS, type BudgetCfg } from "../../core/config.ts";
import {
  changedFiles,
  changedLines,
  diffText,
  gitOk,
  stateHash,
} from "../../core/git.ts";
import { runReview, type Complete } from "../../core/llm.ts";
import {
  createScheduler,
  type Scheduler,
  type SchedulerHooks,
} from "../../core/navigate.ts";
import { formatFindings } from "../../core/review.ts";
import { blockMessage } from "./conversational.ts";

export { ACK_CONTRACT, STEERING_CONTRACT };

export const SUPERSEDED_REASON = "superseded by checkpoint — await new direction";

export const PERSONA_APPEND = `You are pairing with a human. You are the DRIVER; they are the NAVIGATOR.
- Explain your reasoning concisely before each change.
- Prefer small, focused edits.
- When a tool result begins with "${STEERING_CONTRACT.trim()}", treat that as direction and do not assume the tool ran.
- When a tool result is exactly "${ACK_CONTRACT}", re-issue the same call unchanged and continue as planned.
- Be succinct.`;

export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export type PearFlags = {
  navModel: string;
  noNav: boolean;
  pauseLines: number;
  pauseEdits: number;
  minLines: number;
  debounceSeconds: number;
  intervalSeconds: number;
};

export type PearUi = {
  hasUI: boolean;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus: (key: string, text: string | undefined) => void;
};

export type PearDeps = {
  cwd: string;
  flags: PearFlags;
  ui: PearUi;
  complete: Complete | null;
  onFindings: (text: string) => void;
  sendUserMessage: (text: string) => void;
  /** Optional overrides for tests. */
  gitOk?: (cwd: string) => boolean;
  changedLines?: (cwd: string) => number;
  changedFiles?: (cwd: string) => string[];
  stateHash?: (cwd: string) => string;
  diffText?: (cwd: string) => string;
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
  scheduler: Scheduler | null;
  checkpoint: Checkpoint;
  start: () => void;
  stop: () => void;
  safeLines: () => number | null;
  statusText: () => string;
  onToolCall: (event: ToolCallLike) => Promise<ToolCallDecision>;
  onToolResult: (toolCallId: string, isError: boolean) => void;
  onTurnEnd: () => void;
  onAgentStart: () => void;
  onAgentEnd: () => Promise<void>;
  personaSystemPrompt: (base: string) => string;
};

function positiveInt(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return n;
}

/** Resolve pear flags from pi.getFlag values (names without `--`). */
export function resolveFlags(
  getFlag: (name: string) => boolean | string | undefined,
  fallbackNavModel: string = DEFAULTS.navModel,
): PearFlags {
  return {
    navModel: String(getFlag("nav-model") ?? fallbackNavModel),
    noNav: Boolean(getFlag("no-nav")),
    pauseLines: positiveInt("pause-lines", strFlag(getFlag("pause-lines")), DEFAULTS.pauseLines),
    pauseEdits: positiveInt("pause-edits", strFlag(getFlag("pause-edits")), DEFAULTS.pauseEdits),
    minLines: positiveInt("min-lines", strFlag(getFlag("min-lines")), DEFAULTS.minLines),
    debounceSeconds: positiveInt("debounce", strFlag(getFlag("debounce")), DEFAULTS.debounceSeconds),
    intervalSeconds: positiveInt("interval", strFlag(getFlag("interval")), DEFAULTS.intervalSeconds),
  };
}

function strFlag(v: boolean | string | undefined): string | undefined {
  if (typeof v === "string") return v;
  return undefined;
}

export type OnboardingUi = {
  select: (title: string, choices: string[]) => Promise<string | undefined>;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
};

export const ONBOARDING_SKIP = "Skip — use the default model";

/**
 * One-time navigator-model questionnaire. Runs only when nothing already decides
 * the model this session (no CLI override, no persisted preference) and an
 * interactive picker is actually available. Persists the answer to the global
 * pear config via `save` so it applies to every project and host from then on.
 * Returns the chosen model, or undefined if onboarding did not run (caller then
 * uses `DEFAULTS.navModel`).
 */
export async function maybeOnboardNavModel(opts: {
  ui: OnboardingUi;
  hasUI: boolean;
  isGit: boolean;
  noNav: boolean;
  cliOverride: boolean;
  hasPreference: boolean;
  availableModels: string[];
  save: (cfg: { navModel: string }) => void;
}): Promise<string | undefined> {
  if (!opts.hasUI || !opts.isGit || opts.noNav || opts.cliOverride || opts.hasPreference) {
    return undefined;
  }
  const choice = await opts.ui.select(
    "Pick a model for pear's navigator (reviews your uncommitted changes):",
    [...opts.availableModels, ONBOARDING_SKIP],
  );
  if (choice === undefined) return undefined; // dismissed (e.g. Escape) — ask again next session
  const navModel = choice === ONBOARDING_SKIP ? DEFAULTS.navModel : choice;
  try {
    opts.save({ navModel });
    opts.ui.notify(`pear: navigator model set to ${navModel} (saved to ~/.pear/config.json)`, "info");
  } catch (error) {
    opts.ui.notify(`pear: could not save navigator model: ${(error as Error).message}`, "error");
    // Use the selected model for this session; because persistence failed, onboarding repeats next session.
  }
  return navModel;
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
  const filesFn = deps.changedFiles ?? changedFiles;
  const hashFn = deps.stateHash ?? stateHash;
  const diffFn = deps.diffText ?? diffText;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;

  const isGit = gitOkFn(cwd);
  let noNav = deps.flags.noNav || !isGit;
  if (!isGit && deps.ui.hasUI) {
    try {
      deps.ui.notify(
        "not a git repo — navigator disabled, pacing uses mutation count only",
        "warning",
      );
    } catch {
      /* best-effort */
    }
  }

  const budget: BudgetCfg = {
    pauseLines: deps.flags.pauseLines,
    pauseEdits: deps.flags.pauseEdits,
  };
  const checkpoint = createCheckpoint(budget, 0);

  const safeLines = (): number | null => {
    if (!isGit) return null;
    try {
      return linesFn(cwd);
    } catch {
      return null;
    }
  };

  const safeFiles = (): string[] => {
    try {
      return isGit ? filesFn(cwd) : [];
    } catch {
      return [];
    }
  };

  // Initial baseline: pre-existing uncommitted work must not consume the budget.
  checkpoint.resetBaseline(!isGit ? 0 : (safeLines() ?? 0));

  let suppressMutations = false;
  let pollTimer: unknown = null;
  let scheduler: Scheduler | null = null;

  const refreshStatus = () => {
    if (!deps.ui.hasUI) return;
    try {
      deps.ui.setStatus("pear-nav", statusText());
    } catch {
      /* best-effort */
    }
  };

  const statusText = (): string => {
    if (!scheduler) {
      return `pear: nav off | +${deltaLines()}/${deltaMut()} since checkpoint`;
    }
    const parked = scheduler.isParked() ? "parked" : scheduler.getState().toLowerCase();
    return `pear: ${parked} | last: ${scheduler.getLastSummary()} | +${deltaLines()}/${deltaMut()}`;
  };

  const deltaLines = (): number => {
    const snap = checkpoint.snapshot();
    if (snap.rebasePending) return 0;
    const lines = safeLines();
    if (lines === null) return 0;
    return lines - snap.baselineLines;
  };

  const deltaMut = (): number => {
    const snap = checkpoint.snapshot();
    return snap.confirmed + snap.pending;
  };

  const resetAfterCheckpoint = (): void => {
    // One reset expression for every tool_call path (prompt and fail-open).
    checkpoint.resetBaseline(!isGit ? 0 : checkpoint.snapshot().pending > 0 ? null : safeLines());
  };

  if (!noNav && deps.complete) {
    const complete = deps.complete;
    const hooks: SchedulerHooks = {
      now: deps.now ?? (() => Date.now()),
      setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
      getChangedLines: () => linesFn(cwd),
      getDiffText: () => diffFn(cwd),
      runReview: async (diff) => {
        try {
          const { kept, filtered } = await runReview(complete, diff);
          deps.onFindings(formatFindings(kept, filtered));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      onOutput: (text) => {
        // Scheduler only emits here on review failure (findings go through onFindings).
        if (deps.ui.hasUI) {
          try {
            deps.ui.notify(text.trim(), "error");
          } catch {
            /* best-effort */
          }
        }
      },
    };
    scheduler = createScheduler(
      {
        minLines: deps.flags.minLines,
        intervalSeconds: deps.flags.intervalSeconds,
        debounceSeconds: deps.flags.debounceSeconds,
      },
      hooks,
    );
  } else if (!noNav && !deps.complete) {
    noNav = true;
    if (deps.ui.hasUI) {
      try {
        deps.ui.notify("nav model unavailable — navigator disabled", "warning");
      } catch {
        /* best-effort */
      }
    }
  }

  const start = () => {
    if (!scheduler) return;
    pollTimer = setIntervalFn(() => {
      if (!scheduler) return;
      try {
        scheduler.notify(hashFn(cwd));
        refreshStatus();
      } catch {
        /* transient git error: skip tick */
      }
    }, 2000);
    refreshStatus();
  };

  const stop = () => {
    if (pollTimer != null) {
      clearIntervalFn(pollTimer as ReturnType<typeof setInterval>);
      pollTimer = null;
    }
    scheduler?.stop();
  };

  const onToolCall = async (event: ToolCallLike): Promise<ToolCallDecision> => {
    if (!MUTATING_TOOLS.has(event.toolName)) return undefined;

    if (suppressMutations) {
      return { block: true, reason: SUPERSEDED_REASON };
    }

    const lines = safeLines() ?? checkpoint.getBaselineLines();
    if (!checkpoint.check({ lines })) {
      checkpoint.reserve(event.toolCallId);
      return undefined;
    }

    if (!deps.ui.hasUI) {
      // Headless: allow without reserving (settles no-op).
      return undefined;
    }

    const snap = checkpoint.snapshot();
    const summary = buildSummary(
      toolLabel(event),
      {
        lines: snap.rebasePending ? 0 : lines - snap.baselineLines,
        mutations: snap.confirmed + snap.pending,
      },
      safeFiles(),
    );

    // Never await a human inside a tool_call: omp caps handlers at ~30s and
    // injects that abort into ui.input, which then resolves `undefined`. The old
    // code read that as an empty answer and returned ACK_CONTRACT — telling the
    // model to re-issue and continue as if the human had approved. Decide
    // synchronously instead, latch the rest of the batch, and route the actual
    // review to the chat turn, where the human has no deadline.
    suppressMutations = true;
    resetAfterCheckpoint();
    try {
      deps.ui.notify(summary, "warning");
    } catch {
      /* best-effort surfacing; the returned block still carries the summary */
    }
    return { block: true, reason: STEERING_CONTRACT + blockMessage(summary) };
  };

  const onToolResult = (toolCallId: string, isError: boolean) => {
    checkpoint.settle(toolCallId, !isError);
  };

  const onTurnEnd = () => {
    try {
      const l = safeLines();
      if (checkpoint.snapshot().rebasePending) {
        if (l !== null) checkpoint.finishRebase(l);
        else checkpoint.abandonRebase();
      }
    } finally {
      suppressMutations = false;
    }
  };

  const onAgentStart = () => {
    // A new agent turn is the human's reply after an aborted checkpoint.
    suppressMutations = false;
    if (!scheduler) return;
    const wasPending =
      scheduler.getState() === "PENDING" || scheduler.getState() === "WAITING_INTERVAL";
    scheduler.setAgentActive(true);
    if (wasPending && deps.ui.hasUI) {
      try {
        deps.ui.notify("folding pending human edits into this turn", "info");
      } catch {
        /* ignore */
      }
    }
    refreshStatus();
  };

  const onAgentEnd = async () => {
    const lines = safeLines() ?? checkpoint.getBaselineLines();
    try {
      if (deps.ui.hasUI && checkpoint.check({ lines })) {
        const snap = checkpoint.snapshot();
        const summary = buildSummary(
          "end of turn",
          {
            lines: lines - snap.baselineLines,
            mutations: snap.confirmed + snap.pending,
          },
          safeFiles(),
        );
        try {
          // agent_end has the same host deadline as tool_call; never await UI.
          deps.ui.notify(summary, "warning");
        } finally {
          checkpoint.resetBaseline(lines);
        }
      }
    } catch {
      /* headless or UI failure: cleanup below still runs */
    } finally {
      try {
        scheduler?.markReviewed(hashFn(cwd));
      } catch {
        /* git transient */
      }
      try {
        scheduler?.setAgentActive(false);
      } finally {
        refreshStatus();
      }
    }
  };

  return {
    isGit,
    get scheduler() {
      return scheduler;
    },
    checkpoint,
    start,
    stop,
    safeLines,
    statusText,
    onToolCall,
    onToolResult,
    onTurnEnd,
    onAgentStart,
    onAgentEnd,
    personaSystemPrompt: (base) => `${base}\n\n${PERSONA_APPEND}`,
  };
}
