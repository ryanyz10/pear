/**
 * pear as a pi extension.
 *
 * This file is the only pi-specific code in the project; everything it calls
 * lives in `core/`, `adapters/pi/runtime.ts`, or `adapters/pi/cards/`. Porting
 * pear to another harness means rewriting this file alone.
 *
 * API facts relied on here are recorded in `docs/pi-api-notes.md`, verified
 * against the pinned pi version.
 */

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { pointsForWorkingTree } from "../../../core/load.ts";
import {
  captureGitState,
  changedLineStats,
  isGitRepo,
  workingDiffText,
} from "../../../core/git.ts";
import {
  CONFIG_KEYS,
  CONFIG_SPECS,
  ConfigWriteError,
  DEFAULTS,
  MODES,
  formatConfigValue,
  isConfigKey,
  loadConfig,
  nodeFs,
  parseConfigEdit,
  saveConfig,
  type ConfigKey,
  type Mode,
  type PearConfig,
} from "../../../core/config.ts";
import { planFileName, plansDir, writePlan } from "../../../core/plan-file.ts";
import {
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_NAME,
  CHECKPOINT_TOOL_DESCRIPTION,
  CHECKPOINT_TOOL_NAME,
  PLAN_TOOL_DESCRIPTION,
  PLAN_TOOL_NAME,
  NOTHING_TO_EXPLAIN,
  SCOPING_PERSONA,
  buildPersona,
  formatPlan,
  humanDriverPersona,
  nudgeLines,
  parkedNotice,
  quizPrompt,
  resultCheckpointFailed,
  withDiff,
  type PlanSpec,
} from "../../../core/prompts.ts";
import { createWatcher, type WatchEffect, type Watcher } from "../../../core/watch.ts";
import { askCard } from "../cards/ask.ts";
import { renderCard, type CardSpec } from "../cards/card.ts";
import { checkpointCard, type CheckpointView } from "../cards/checkpoint.ts";
import { settingCard, settingsCard } from "../cards/config.ts";
import { runCardViaDialogs } from "../cards/dialogs.ts";
import { planCard } from "../cards/plan.ts";
import { createRuntime, type PearRuntime, type Resolution } from "../runtime.ts";

// --------------------------------------------------------------- tool schemas

const AskParams = Type.Object({
  question: Type.String({ description: "What you need the navigator to decide." }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "A concrete answer they can pick." }),
      description: Type.Optional(Type.String({ description: "Why they might pick it." })),
    }),
    { description: "2-4 answers you would actually be happy to act on." },
  ),
});

const PlanParams = Type.Object({
  summary: Type.String({ description: "How you intend to solve it, in a sentence or two." }),
  context: Type.Optional(
    Type.String({ description: "What you learned while scoping — the problem, constraints, why this approach." }),
  ),
  steps: Type.Array(Type.String(), {
    description: "The steps, in the order you will do them. Each is one bounded action the navigator can recognise happening.",
  }),
  decisions: Type.Optional(
    Type.Array(Type.String(), {
      description: "What the navigator decided during scoping (ask answers, steering).",
    }),
  ),
  openQuestions: Type.Optional(
    Type.Array(Type.String(), {
      description: "Anything still unresolved — shown on the card so it is not silently guessed.",
    }),
  ),
  risks: Type.Optional(
    Type.Array(Type.String(), { description: "Anything that might go wrong or need a decision." }),
  ),
});

const CheckpointParams = Type.Object({
  summary: Type.String({ description: "What you changed and why, in plain language." }),
  files: Type.Array(Type.String(), { description: "Files you touched, so the human can review them." }),
  next: Type.String({ description: "What you plan to do next." }),
});

type CardDetails = {
  kind: "ask" | "plan" | "checkpoint";
  headline: string;
  answer: string;
};

/** Session entry type used to persist the approved plan across reloads. */
const PLAN_ENTRY = "pear-plan";

/**
 * Session entry type used to *show* the approved plan in the chat history.
 *
 * Deliberately not `PLAN_ENTRY`, for two reasons that pull in opposite
 * directions and would both be violated by sharing one key. `recoverPlan` reads
 * the newest `PLAN_ENTRY` back as *the approved plan*, so nothing written for
 * display may land under that key. And `PLAN_ENTRY` must keep no renderer, or
 * resuming an older session would suddenly paint every plan it ever approved
 * into the transcript.
 */
const PLAN_VIEW_ENTRY = "pear-plan-view";

/**
 * Card answers that mean a human read the proposal, and so that it is worth
 * writing to the plan's file. Deliberately excludes `not-run` (no card
 * was shown), `mode-off` (torn down by a mode switch) and `error` (the card
 * failed to render).
 */
const SAVED_PLAN_ANSWERS = new Set(["approve", "revise", "explore", "dismissed"]);

/** Widget key for the passive nudge. Keyed so re-setting it refreshes in place. */
const NUDGE_KEY = "pear-nudge";

/** Tools removed while scoping. `bash` stays, gated per-command by the hook. */
const WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * pi's own tools. Used only by `exclusive`, and by name on purpose: `SourceInfo`
 * carries `{ path, source, scope, origin }` where `origin` is
 * `"package" | "top-level"`, which does not separate a built-in from a
 * third-party extension's tool. Names do.
 */
const PI_BUILTIN_TOOLS = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

const PEAR_TOOLS = new Set([ASK_TOOL_NAME, PLAN_TOOL_NAME, CHECKPOINT_TOOL_NAME]);

/** An absent value, or an array of strings. Three of `PlanSpec`'s fields. */
function isOptionalStringArray(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every((s) => typeof s === "string"));
}

/**
 * Guard for a plan recovered from session history.
 *
 * Every field is checked, not just the ones the first version of `PlanSpec`
 * had: `formatPlan` calls `.trim()` on `context`, so a non-string there throws
 * inside `before_agent_start` rather than degrading. Growing this alongside the
 * type is what keeps a malformed entry a no-op instead of a crash.
 */
function isPlanSpec(value: unknown): value is PlanSpec {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" &&
    Array.isArray(v.steps) &&
    v.steps.every((s) => typeof s === "string") &&
    (v.context === undefined || typeof v.context === "string") &&
    isOptionalStringArray(v.decisions) &&
    isOptionalStringArray(v.openQuestions) &&
    isOptionalStringArray(v.risks)
  );
}

/**
 * Injectable timer, so the watcher's lifecycle is testable without a real
 * clock. pi calls the factory with one argument; this is only ever supplied by
 * tests.
 */
export type PearHooks = {
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: never) => void;
  now?: () => number;
};

export default function pear(pi: ExtensionAPI, hooks: PearHooks = {}) {
  const startTimer = hooks.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = hooks.clearInterval ?? ((h) => clearInterval(h));
  const now = hooks.now ?? (() => Date.now());
  // `runtime.mode` is the single source of truth for the mode this session is
  // actually running, which can differ from what is on disk (see the headless
  // policy below). Deliberately not mirrored in a second variable.
  let runtime: PearRuntime | null = null;

  /**
   * The settings this session is running with.
   *
   * Deliberately not the source of truth for anything the runtime owns —
   * `runtime.mode` is still the only answer to "what mode is this session", and
   * this may differ from it (headless fail-closed). It exists because the
   * watcher and the nudge need values that live nowhere else, and because
   * `/pear-config` has to show what is in force rather than what is on disk.
   */
  let settings: Required<PearConfig> = { ...DEFAULTS };

  /**
   * Tools pear took away when it entered scoping, so it can put back exactly
   * those and nothing else. Never a hardcoded restore list: another extension
   * may legitimately have changed the tool set in the meantime.
   */
  let suppressedTools: string[] = [];

  /**
   * Where the currently-approved plan was written, for `/pear-plan` to quote.
   * Null in a session that recovered its plan from history rather than
   * approving one, since that file belongs to the earlier session.
   */
  let approvedPlanFile: string | null = null;

  /**
   * The filename this scoping round's plan is being written to, assigned when
   * it was first proposed. Held here rather than derived per call so that a
   * revision rewrites the same file even when the summary is reworded.
   *
   * Cleared at every round boundary — a new mode, a `/pear` replan, and
   * approval itself — so a later plan can never overwrite an approved one.
   */
  let planFile: string | null = null;

  const captureFiles = (cwd: string) => () => {
    const state = captureGitState(cwd);
    return state.ok ? state.files : null;
  };

  const refreshStatus = (ctx: ExtensionContext) => {
    if (runtime === null) return;
    try {
      ctx.ui.setStatus("pear", runtime.statusText());
    } catch {
      /* status is cosmetic */
    }
  };

  /**
   * `ui.custom` only works in the TUI. `hasUI` is also true in RPC, where it
   * silently no-ops, so tiering on `hasUI` would degrade a card to nothing.
   * See docs/pi-api-notes.md.
   */
  const canShowCard = (ctx: ExtensionContext) => ctx.mode === "tui";
  const canShowDialogs = (ctx: ExtensionContext) => ctx.hasUI;

  // ------------------------------------------------------------- tool gating

  const suppressWriteTools = () => {
    const active = pi.getActiveTools();
    const toRemove = active.filter((t) => WRITE_TOOLS.has(t));
    // Nothing to take away means nothing to remember. Assigning here regardless
    // would wipe the memory of an earlier suppression — and `syncPhaseTools`
    // runs after every card, so a `pear_ask` during scoping (which the scoping
    // persona asks for) would leave nothing to restore when the plan lands.
    if (toRemove.length === 0) return;
    suppressedTools = toRemove;
    pi.setActiveTools(active.filter((t) => !WRITE_TOOLS.has(t)));
  };

  /**
   * Put back exactly what scoping removed.
   *
   * This runs **inside `pear_plan.execute`**, mid-run. pi supports that, but
   * only for a *purely additive* change: it detects the addition, records the
   * new names on the tool result, and exposes the definitions before the next
   * model request (docs `extensions.md`, "Dynamic Tool Loading"). Removing a
   * currently-active tool in the same call forfeits that, which is why this
   * starts from the live list and only ever appends.
   */
  const restoreWriteTools = () => {
    if (suppressedTools.length === 0) return;
    const restored = [...pi.getActiveTools()];
    for (const name of suppressedTools) {
      if (!restored.includes(name)) restored.push(name);
    }
    suppressedTools = [];
    pi.setActiveTools(restored);
  };

  /** Tools that are neither pi's nor pear's. */
  const foreignTools = (): string[] =>
    pi.getActiveTools().filter((n) => !PI_BUILTIN_TOOLS.has(n) && !PEAR_TOOLS.has(n));

  const applyExclusive = (ctx: ExtensionContext): string[] => {
    const foreign = foreignTools();
    if (foreign.length === 0) return [];
    pi.setActiveTools(pi.getActiveTools().filter((n) => !foreign.includes(n)));
    refreshStatus(ctx);
    return foreign;
  };

  /**
   * Keep the tool set consistent with who may edit right now.
   *
   * Two situations remove the write tools, for the same reason: nothing the
   * agent does should touch the tree. Before a plan exists, and whenever the
   * human is the one driving.
   */
  const syncPhaseTools = () => {
    if (runtime === null) return;
    const agentMayEdit =
      runtime.mode !== "off" && runtime.phase === "building" && runtime.driver === "agent";
    if (agentMayEdit) restoreWriteTools();
    else suppressWriteTools();
  };

  // ----------------------------------------------------------- the watcher

  let watcher: Watcher | null = null;
  let pollTimer: { unref?: () => void } | null = null;

  /**
   * Start watching the working tree.
   *
   * Started here rather than in the extension factory, which pi documents as a
   * hard rule (`extensions.md:220`): a factory can run in an invocation that
   * never opens a session, and a timer started there would leak. Session
   * switches re-fire `session_start`/`session_shutdown`, so this self-heals.
   */
  const startWatching = (ctx: ExtensionContext): void => {
    stopWatching(ctx);
    if (runtime === null || runtime.driver !== "human") return;

    watcher = createWatcher({
      debounceMs: settings.debounceMs,
      maxFailures: settings.maxPollFailures,
      sample: () => {
        const state = captureGitState(ctx.cwd);
        if (!state.ok) return { ok: false, detail: state.detail };
        // The per-file token map already fingerprints content, so joining it is
        // a content-sensitive "has anything moved" signal for free.
        const token = [...state.files].map(([path, t]) => `${path}\u0000${t}`).sort().join("\n");
        return { ok: true, token };
      },
      measure: () => {
        const result = changedLineStats(ctx.cwd);
        return result.ok
          ? { ok: true, ...result.stats }
          : { ok: false, detail: result.detail };
      },
      budget: () => runtime?.reviewBudget ?? 0,
      // Read live off the runtime, which owns the tiers: `/pear-config` moves
      // them through `setTiers` without rebuilding the watcher.
      softFraction: () => runtime?.softFraction ?? DEFAULTS.softFraction,
      blockMultiple: () => runtime?.blockMultiple ?? DEFAULTS.blockMultiple,
      now,
      emit: (effect) => {
        void onWatchEffect(ctx, effect);
      },
    });

    pollTimer = startTimer(() => {
      try {
        watcher?.tick();
      } catch {
        // A throw here would take down the interval and silently stop watching.
        // The watcher's own failure counter is what handles persistent trouble.
      }
    }, settings.pollMs);
    // Never hold the process open just to poll.
    pollTimer.unref?.();
  };

  const stopWatching = (ctx: ExtensionContext): void => {
    if (pollTimer !== null) {
      stopTimer(pollTimer as never);
      pollTimer = null;
    }
    watcher?.stop();
    watcher = null;
    try {
      ctx.ui.setWidget(NUDGE_KEY, undefined);
    } catch {
      /* the widget is cosmetic */
    }
  };

  /** Keep the watcher running exactly when the human is driving. */
  const syncWatcher = (ctx: ExtensionContext): void => {
    if (runtime !== null && runtime.driver === "human" && runtime.mode !== "off") {
      startWatching(ctx);
    } else {
      stopWatching(ctx);
    }
  };

  async function onWatchEffect(ctx: ExtensionContext, effect: WatchEffect): Promise<void> {
    const rt = runtime;
    if (rt === null) return;

    switch (effect.kind) {
      // Every measurement reports its load here and nowhere else, so the status
      // line tracks the tree at every tier rather than only once a nudge is due.
      case "load":
        rt.setWorkingTreeLoad(effect.points);
        refreshStatus(ctx);
        return;

      case "nudge":
        // Turning the nudge off silences the warning shot, not the accounting —
        // the trigger that starts a review turn is the blocked tier and is not
        // affected by this.
        if (settings.nudge) {
          try {
            ctx.ui.setWidget(
              NUDGE_KEY,
              nudgeLines(
                effect.files,
                effect.insertions + effect.deletions,
                effect.tier === "due",
                settings.statusIcon,
              ),
              { placement: "aboveEditor" },
            );
          } catch {
            /* setWidget is TUI-only; RPC simply gets no warning shot */
          }
        }
        refreshStatus(ctx);
        return;

      case "clear":
        try {
          ctx.ui.setWidget(NUDGE_KEY, undefined);
        } catch {
          /* cosmetic */
        }
        refreshStatus(ctx);
        return;

      case "trigger": {
        const asked = startQuiz(ctx, effect.files, effect.insertions, effect.deletions);
        // The watcher parks itself on `triggered` waiting to be answered. If the
        // question never got out, nothing will ever answer it, and without this
        // the watcher would go quiet for the rest of the session.
        if (!asked) watcher?.rearm();
        return;
      }

      case "parked":
        stopWatching(ctx);
        ctx.ui.notify(parkedNotice(effect.detail), "warning");
        refreshStatus(ctx);
        return;

      case "none":
        return;
    }
  }

  /**
   * Ask the human to explain themselves, by starting a turn.
   *
   * `sendUserMessage` rather than `sendMessage({triggerTurn: true})`: only the
   * former routes through pi's `prompt()`, which is what fires
   * `before_agent_start` and therefore injects the navigator persona. The
   * latter calls the agent directly and the model would have no idea it is
   * reviewing.
   */
  /** @returns whether the question was actually delivered. */
  function startQuiz(
    ctx: ExtensionContext,
    files: number,
    insertions: number,
    deletions: number,
    /** `/pear-explain` — asked for deliberately, so don't second-guess timing. */
    manual = false,
  ): boolean {
    const rt = runtime;
    if (rt === null) return false;

    // A turn started mid-stream throws, so the idle check holds either way.
    if (!ctx.isIdle()) {
      if (manual) {
        ctx.ui.notify("pear: the agent is mid-turn — try /pear-explain again in a moment.", "warning");
      }
      return false;
    }
    // The editor check only guards *unprompted* turns: auto-triggering
    // underneath a half-typed message buries what the human was writing. Typing
    // the command is itself the answer to "is now a good time?".
    if (!manual) {
      try {
        if (ctx.ui.getEditorText().trim() !== "") return false;
      } catch {
        /* no editor to check outside the TUI; the idle check stands alone */
      }
    }

    const { files: paths } = rt.filesSinceBaseline();
    rt.beginQuiz();
    try {
      ctx.ui.setWidget(NUDGE_KEY, undefined);
    } catch {
      /* cosmetic */
    }
    // Prefer git's named paths; fall back to the count when the file list is
    // unavailable, so the agent is still told the scale of what changed.
    const named = paths.length > 0 ? paths : Array.from({ length: files }, () => "(unnamed)");
    pi.sendUserMessage(quizPrompt(named, insertions, deletions));
    refreshStatus(ctx);
    return true;
  }

  // ----------------------------------------------------------------- session

  pi.on("session_start", (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    settings = loaded.config;

    if (loaded.legacyMode !== undefined) {
      ctx.ui.notify(
        `pear: "${loaded.legacyMode}" mode isn't available in this version — running off. ` +
          `Your config file was left unchanged. Use /pear-mode for agent-driver.`,
        "warning",
      );
    }
    if (loaded.malformed) {
      ctx.ui.notify(
        "pear: .pear/config.json could not be parsed — using defaults. " +
          "It will be backed up before any change is saved.",
        "warning",
      );
    }
    if (loaded.migratedBudgetFrom !== undefined) {
      ctx.ui.notify(
        `pear: checkpoints are now paced by review load, not change count. Your ` +
          `maxChangesPerCheckpoint=${loaded.migratedBudgetFrom} reads as reviewBudget=` +
          `${loaded.config.reviewBudget}. Tune it with /pear-config; the old key is untouched.`,
        "info",
      );
    }

    // Headless fail-closed: never approve changes without a human present.
    let startMode: Mode = loaded.config.mode;
    if (startMode !== "off" && !canShowDialogs(ctx)) {
      ctx.ui.notify(
        "pear: needs an interactive session to check in with you — running off for this session. " +
          "Config unchanged.",
        "warning",
      );
      startMode = "off";
    }

    // human-driver detects the human's edits through git and has no other way
    // to see them, so outside a repo there is nothing to fall back to.
    if (startMode === "human-driver" && !isGitRepo(ctx.cwd)) {
      ctx.ui.notify(
        "pear: human-driver needs a git repository to see what you change — running off for this " +
          "session. Config unchanged.",
        "warning",
      );
      startMode = "off";
    }

    runtime = createRuntime({
      mode: startMode,
      reviewBudget: loaded.config.reviewBudget,
      planPhase: loaded.config.planPhase,
      allowedReadOnlyCommands: loaded.config.allowedReadOnlyCommands,
      softFraction: loaded.config.softFraction,
      blockMultiple: loaded.config.blockMultiple,
      statusIcon: loaded.config.statusIcon,
      captureFiles: captureFiles(ctx.cwd),
    });

    // A plan approved earlier in this session survives a reload, so the loop
    // does not silently drop back into scoping and re-litigate it.
    if (startMode !== "off" && loaded.config.planPhase) {
      const recovered = recoverPlan(ctx);
      if (recovered !== undefined) {
        runtime.restorePlan(recovered);
        ctx.ui.notify("pear: picked up the plan you already approved.", "info");
      }
    }

    syncPhaseTools();
    syncWatcher(ctx);

    if (startMode !== "off") {
      if (loaded.config.exclusive) {
        const dropped = applyExclusive(ctx);
        if (dropped.length > 0) {
          ctx.ui.notify(`pear: exclusive mode — disabled ${dropped.join(", ")}.`, "info");
        }
      } else {
        const foreign = foreignTools();
        if (foreign.length > 0) {
          ctx.ui.notify(
            `pear: ${foreign.length} tool(s) from other extensions are active (${foreign.slice(0, 5).join(", ")}). ` +
              `pear is prescriptive and works best alone — /pear-exclusive turns them off.`,
            "info",
          );
        }
      }
    }

    refreshStatus(ctx);
  });

  /** The newest valid plan recorded in this session, if any. */
  function recoverPlan(ctx: ExtensionContext): PlanSpec | undefined {
    let found: PlanSpec | undefined;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY) continue;
        if (isPlanSpec(entry.data)) found = entry.data;
      }
    } catch {
      /* session history is a convenience here, never a requirement */
    }
    return found;
  }

  /**
   * Nothing may outlive the session — neither a pending card nor a timer.
   * Session switches re-fire `session_start` afterwards, so a fresh watcher is
   * built for the new session rather than the old one leaking into it.
   */
  pi.on("session_shutdown", (_event, ctx) => {
    runtime?.resolvePending({ kind: "dismissed" });
    stopWatching(ctx);
  });

  // ----------------------------------------------------------------- persona

  pi.on("before_agent_start", (event) => {
    if (runtime === null || runtime.mode === "off") return undefined;
    const plan = runtime.planText() ?? "(no plan was recorded — ask what they want.)";
    const persona =
      runtime.phase === "scoping"
        ? SCOPING_PERSONA
        : runtime.driver === "human"
          ? humanDriverPersona(plan)
          : buildPersona(plan, runtime.plan?.openQuestions);
    return { systemPrompt: `${event.systemPrompt}\n\n${persona}` };
  });

  // -------------------------------------------------------------- the gate

  pi.on("tool_call", (event, ctx) => {
    if (runtime === null) return undefined;
    const decision = runtime.onMutatingToolCall(
      event.toolName,
      event.toolCallId,
      event.input as Record<string, unknown>,
    );
    refreshStatus(ctx);
    // NOTE: no ctx.abort(). Returning the block is what lets the model read the
    // reason and recover; aborting is what broke the first version. Also note
    // there is no `await` anywhere in this handler.
    return decision;
  });

  pi.on("tool_result", (event, ctx) => {
    if (runtime === null) return undefined;
    const note = runtime.onToolResult(event.toolCallId, event.isError);
    refreshStatus(ctx);
    if (note === undefined) return undefined;
    // `content` REPLACES what the model sees, so the original blocks must be
    // carried through. Dropping them would silently blind the model to its own
    // tool output.
    return { content: [...event.content, { type: "text" as const, text: note }] };
  });

  /**
   * Only genuine user input clears a hold. `source === "extension"` is a message
   * injected by an extension via sendUserMessage, which must not be able to
   * override the human.
   */
  pi.on("input", (event, ctx) => {
    const rt = runtime;
    if (rt === null) return undefined;
    // pear's own injected quiz must not clear the holds it just set, nor get a
    // diff stapled to itself.
    if (event.source === "extension") return undefined;

    const wasQuizzing = rt.quizzing;
    rt.onUserInput();
    if (wasQuizzing) rt.onQuizReply();
    refreshStatus(ctx);
    if (!wasQuizzing) return undefined;

    // This is the human's explanation. Attach what actually changed so the
    // agent can compare the two in a single turn — the mismatch between them
    // is the most valuable thing it can find.
    const diff = workingDiffText(ctx.cwd);
    // No diff, or an unreadable one, means the explanation goes through as the
    // human wrote it. Better than breaking their turn over a git hiccup.
    if (diff === null || diff === "") return undefined;
    return { action: "transform" as const, text: withDiff(event.text, diff) };
  });

  /**
   * `agent_settled` — not `agent_end` — is the terminal boundary: pi may still
   * auto-retry or run a queued continuation after `agent_end`.
   */
  pi.on("agent_settled", (_event, ctx) => {
    if (runtime === null || runtime.mode === "off") return;

    if (runtime.quizzing) {
      // A quiz spans *two* agent runs: the one pear starts to ask the question,
      // and the one the human's answer starts. Ending it on the first would
      // rebaseline before they had said anything — the diff would never be
      // attached and the next nudge would skip work nobody discussed.
      if (runtime.quizAnswered) {
        // Acknowledgement inverts in human-driver: the *agent* is the navigator,
        // and it has now seen the diff — whatever the human said back, including
        // "not now". Re-raising work already discussed would be a nag.
        runtime.endQuiz();
        watcher?.acknowledge();
      }
      refreshStatus(ctx);
      return;
    }

    const report = runtime.onAgentSettled();

    if (report.awaitingExplanation !== null) {
      ctx.ui.notify(
        `pear: you asked about ${report.awaitingExplanation} but the turn ended without a follow-up. ` +
          `Run /pear-checkpoint to get your options back.`,
        "warning",
      );
    } else if (report.points > 0 && runtime.phase === "building") {
      ctx.ui.notify(
        `pear: ${report.points} review point(s) not yet checkpointed. Run /pear-checkpoint to review them.`,
        "info",
      );
    }
    refreshStatus(ctx);
  });

  // ------------------------------------------------------------------- cards

  let cardWorkingVisible = true;
  const setCardWorkingVisible = (ctx: ExtensionContext, visible: boolean): void => {
    if (cardWorkingVisible === visible) return;
    try {
      ctx.ui.setWorkingVisible(visible);
      cardWorkingVisible = visible;
    } catch {
      /* an older host may not expose this cosmetic control */
    }
  };

  /**
   * Show a card and return the human's answer, or `null` if they walked away.
   *
   * Throws only if the host UI itself fails; callers turn that into a normal
   * tool result rather than letting it surface as a bare host error.
   */
  async function show<A>(ctx: ExtensionContext, spec: CardSpec<A>): Promise<A | null> {
    if (canShowCard(ctx)) {
      // Inline custom components replace pi's editor instead of covering the
      // transcript. Hide the animated working row while the card is mounted:
      // when a tall inline card pushes that row out of view, every spinner tick
      // otherwise forces a full redraw that can clear terminal scrollback.
      setCardWorkingVisible(ctx, false);
      try {
        return await ctx.ui.custom<A | null>((tui, theme, _kb, done) =>
          renderCard(tui, theme, done, spec),
        );
      } finally {
        setCardWorkingVisible(ctx, true);
      }
    }
    return await runCardViaDialogs(ctx, spec);
  }

  /**
   * The whole lifecycle of one card: open a slot, race the human against every
   * teardown path, apply the answer.
   *
   * `begin` returns either a slot or an immediate result (wrong phase, mode off,
   * another card already open). `apply` turns an answer into the model-visible
   * result and the state change that goes with it.
   */
  async function runCard<A>(
    ctx: ExtensionContext,
    kind: CardDetails["kind"],
    headline: string,
    begin: (rt: PearRuntime) => ReturnType<PearRuntime["beginCheckpoint"]> | unknown,
    spec: () => CardSpec<A>,
    dismissed: A,
    apply: (rt: PearRuntime, answer: A) => Resolution,
  ): Promise<{ text: string; terminate: boolean; details: CardDetails }> {
    const rt = runtime;
    const detail = (answer: string): CardDetails => ({ kind, headline, answer });

    if (rt === null) {
      return {
        text: resultCheckpointFailed("pear is not initialised"),
        terminate: false,
        details: detail("error"),
      };
    }

    const started = begin(rt) as
      | { pending: { promise: Promise<A>; settle: (a: A) => void } }
      | { immediate: Resolution };

    if ("immediate" in started) {
      return {
        text: started.immediate.text,
        terminate: started.immediate.terminate,
        details: detail("not-run"),
      };
    }

    let answer: A;
    try {
      // Race the human against every way this can be torn down. Whichever
      // resolves first wins; the loser is a no-op because `settle` and the
      // promise are both idempotent.
      const answered = show(ctx, spec()).then((a) => {
        const resolved = a ?? dismissed;
        started.pending.settle(resolved);
        return resolved;
      });
      try {
        answer = await Promise.race([started.pending.promise, answered]);
      } finally {
        // Abort, mode changes, and session shutdown can resolve the runtime's
        // promise without resolving ui.custom, so show()'s finally may not run.
        setCardWorkingVisible(ctx, true);
      }
    } catch (e) {
      // A UI failure must not leave the card pending or the baseline moved.
      rt.resolvePending({ kind: "dismissed" });
      const message = e instanceof Error ? e.message : String(e);
      const resolution = apply(rt, dismissed);
      refreshStatus(ctx);
      return {
        text: `${resultCheckpointFailed(message)}\n\n${resolution.text}`,
        terminate: resolution.terminate,
        details: detail("error"),
      };
    }

    const resolution = apply(rt, answer);
    syncPhaseTools();
    refreshStatus(ctx);
    return {
      text: resolution.text,
      terminate: resolution.terminate,
      details: detail((answer as { kind?: string }).kind ?? "unknown"),
    };
  }

  /** Shared by the checkpoint tool and the /pear-checkpoint command. */
  async function runCheckpoint(
    ctx: ExtensionContext,
    claimed: { summary: string; files: string[]; next: string },
  ) {
    let view: CheckpointView = {
      summary: claimed.summary,
      next: claimed.next,
      claimedFiles: claimed.files,
      gitFiles: [],
      verified: false,
    };
    return await runCard(
      ctx,
      "checkpoint",
      claimed.summary,
      (rt) => {
        const started = rt.beginCheckpoint();
        // Capture the file list only once a card is actually going to be shown.
        if ("pending" in started) {
          const { files, verified } = rt.filesSinceBaseline();
          view = { ...view, gitFiles: files, verified };
        }
        return started;
      },
      () => checkpointCard(view),
      { kind: "dismissed" },
      (rt, answer) => rt.applyCheckpointAnswer(answer),
    );
  }

  // --------------------------------------------------- the plan in the chat

  /**
   * Paint an approved plan into the transcript.
   *
   * This is the durable copy after the interactive component vanishes. Regular
   * mode may retain card rows in terminal scrollback, while fullscreen mode
   * cannot; the transcript entry gives both modes the same lasting plan.
   *
   * Rendered in full regardless of `expanded`. Entries honour pi's collapse
   * toggle, but a plan collapsed to one line is exactly the thing this is meant
   * to stop, so the toggle is ignored rather than obeyed.
   */
  pi.registerEntryRenderer<PlanSpec>(PLAN_VIEW_ENTRY, (entry, _options, theme) => {
    // Entries are replayed from disk, so this may be data written by an older
    // version. A shape we do not recognise renders nothing rather than throwing
    // inside pi's render loop.
    if (!isPlanSpec(entry.data)) return undefined;
    const heading = theme.fg("accent", theme.bold("the plan we agreed"));
    const body = theme.fg("muted", formatPlan(entry.data));
    return new Text(`${heading}\n${body}`, 1, 0);
  });

  // ------------------------------------------------------------------- tools

  const renderCardCall = (
    theme: Theme,
    label: string,
    headline: string,
    count: number | undefined,
    unit = "file",
  ): Text => {
    const head = theme.fg("toolTitle", theme.bold(`${label} `));
    const body = theme.fg("muted", headline);
    const tail =
      count === undefined || count === 0
        ? ""
        : theme.fg("dim", `\n  ${count} ${unit}${count === 1 ? "" : "s"}`);
    return new Text(head + body + tail, 0, 0);
  };

  pi.registerTool({
    name: ASK_TOOL_NAME,
    label: "Ask",
    description: ASK_TOOL_DESCRIPTION,
    parameters: AskParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const onAbort = () => runtime?.resolvePending({ kind: "dismissed" });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const { text, terminate, details } = await runCard(
          ctx,
          "ask",
          params.question,
          (rt) => rt.beginAsk(),
          () => askCard({ question: params.question, choices: params.options }),
          { kind: "dismissed" as const },
          (rt, answer) => rt.applyAskAnswer(answer),
        );
        return { content: [{ type: "text" as const, text }], details, terminate };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    renderCall: (args, theme) => renderCardCall(theme, "ask", String(args.question ?? ""), undefined),
    renderResult: (result, _options, theme) => renderAnswer(result.details, theme),
  });

  pi.registerTool({
    name: PLAN_TOOL_NAME,
    label: "Plan",
    description: PLAN_TOOL_DESCRIPTION,
    parameters: PlanParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const onAbort = () => runtime?.resolvePending({ kind: "dismissed" });
      signal?.addEventListener("abort", onAbort, { once: true });
      const proposed: PlanSpec = {
        summary: params.summary,
        steps: params.steps,
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.decisions !== undefined ? { decisions: params.decisions } : {}),
        ...(params.openQuestions !== undefined ? { openQuestions: params.openQuestions } : {}),
        ...(params.risks !== undefined ? { risks: params.risks } : {}),
      };
      try {
        const result = await runCard(
          ctx,
          "plan",
          params.summary,
          (rt) => rt.beginPlan(),
          () => planCard(proposed, runtime?.planDrafts ?? 0),
          { kind: "dismissed" as const },
          (rt, answer) => {
            const resolution = rt.applyPlanAnswer(answer, proposed);
            // Persist only what the human actually approved, and only after the
            // runtime has accepted it, so history cannot claim more than state.
            if (answer.kind === "approve") {
              try {
                pi.appendEntry(PLAN_ENTRY, proposed);
                // A second entry, for reading rather than for state. Written on
                // approval only: appending every proposal would put a full copy
                // of the plan in the transcript for each revision, and a
                // scoping round routinely runs to four or five.
                pi.appendEntry(PLAN_VIEW_ENTRY, proposed);
              } catch {
                /* the plan still holds for this session */
              }
            }
            return resolution;
          },
        );
        let text = result.text;
        // Save only what a human actually looked at. "not-run" means the call
        // was rejected before a card existed; "mode-off" and "error" mean the
        // card was torn down before anyone read it — rewriting the plan's file
        // with a proposal nobody saw would misrepresent what is being planned.
        if (result.details.kind === "plan" && SAVED_PLAN_ANSWERS.has(result.details.answer)) {
          try {
            // Name it once. Every revision of this plan rewrites this file, so
            // the summary that named it is the one it was first proposed under.
            planFile ??= planFileName(proposed.summary);
            const approved = result.details.answer === "approve";
            const path = writePlan(
              ctx.cwd,
              proposed,
              planFile,
              approved ? "approved" : "draft",
              nodeFs,
              now,
            );
            // Where it is, either way: a draft you can go back to is the point
            // of naming these at all.
            text = `${result.text}\n\nSaved to ${path}.`;
            if (approved) {
              approvedPlanFile = path;
              // The round is over. Anything proposed later is a different plan
              // and gets a different file, so this one stays as approved.
              planFile = null;
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`pear: the plan was not saved to disk (${message}).`, "warning");
          }
        }
        return {
          content: [{ type: "text" as const, text }],
          details: result.details,
          terminate: result.terminate,
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    renderCall: (args, theme) =>
      renderCardCall(
        theme,
        "plan",
        String(args.summary ?? ""),
        Array.isArray(args.steps) ? args.steps.length : undefined,
        "step",
      ),
    renderResult: (result, _options, theme) => renderAnswer(result.details, theme),
  });

  pi.registerTool({
    name: CHECKPOINT_TOOL_NAME,
    label: "Checkpoint",
    description: CHECKPOINT_TOOL_DESCRIPTION,
    parameters: CheckpointParams,
    // Keeps a card from opening while sibling mutations are still writing.
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const onAbort = () => runtime?.resolvePending({ kind: "dismissed" });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const { text, terminate, details } = await runCheckpoint(ctx, {
          summary: params.summary,
          files: params.files,
          next: params.next,
        });
        return { content: [{ type: "text" as const, text }], details, terminate };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    renderCall: (args, theme) =>
      renderCardCall(
        theme,
        "checkpoint",
        String(args.summary ?? ""),
        Array.isArray(args.files) ? args.files.length : undefined,
      ),
    renderResult: (result, _options, theme) => renderAnswer(result.details, theme),
  });

  function renderAnswer(details: unknown, theme: Theme): Text {
    const d = details as CardDetails | undefined;
    if (d === undefined) return new Text("", 0, 0);
    const marks: Record<string, [ThemeColor, string]> = {
      continue: ["success", "✓ keep going"],
      approve: ["success", "✓ approved"],
      answer: ["success", "✓ answered"],
      explain: ["accent", "◦ walk me through it"],
      steer: ["accent", "✎ change direction"],
      revise: ["accent", "✎ revise the plan"],
      explore: ["accent", "◦ keep exploring"],
      stop: ["warning", "■ stop"],
      dismissed: ["dim", "— dismissed"],
    };
    const mark = marks[d.answer];
    return new Text(mark === undefined ? theme.fg("dim", d.answer) : theme.fg(mark[0], mark[1]), 0, 0);
  }

  // ---------------------------------------------------------------- commands

  const needRuntime = (ctx: ExtensionContext): PearRuntime | null => {
    if (runtime === null) ctx.ui.notify("pear: not initialised", "warning");
    return runtime;
  };

  pi.registerCommand("pear", {
    description: "Start over: go back to agreeing an approach",
    handler: async (_args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      if (rt.mode === "off") {
        ctx.ui.notify("pear: not running — use /pear-mode first.", "warning");
        return;
      }
      // A new round of scoping is a new plan: it gets its own file rather than
      // rewriting the one that was already approved.
      planFile = null;
      rt.replan();
      syncPhaseTools();
      syncWatcher(ctx);
      refreshStatus(ctx);
      ctx.ui.notify(
        "pear: back to scoping — editing is closed until a new plan is approved.",
        "info",
      );
    },
  });

  pi.registerCommand("pear-plan", {
    description: "Show the plan you agreed to",
    handler: async (_args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      const plan = rt.plan;
      if (plan === null) {
        ctx.ui.notify(
          `pear: no plan approved yet — drafts save under ${plansDir(ctx.cwd)}.`,
          "info",
        );
        return;
      }
      // This plan's own file. Superseding it means writing a different file,
      // so the path stays true for as long as the plan does.
      const where = approvedPlanFile === null ? "" : ` (saved at ${approvedPlanFile})`;
      ctx.ui.notify(`pear plan${where}\n\n${formatPlan(plan)}`, "info");
    },
  });

  pi.registerCommand("pear-swap", {
    description: "Hand the keyboard over: swap who is driving",
    handler: async (_args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      if (rt.mode === "off") {
        ctx.ui.notify("pear: not running — use /pear-mode first.", "warning");
        return;
      }
      if (rt.driver === "agent" && !isGitRepo(ctx.cwd)) {
        ctx.ui.notify(
          "pear: can't watch your changes outside a git repository, so you can't take the keyboard here.",
          "warning",
        );
        return;
      }

      const driver = rt.swap();
      syncPhaseTools();
      syncWatcher(ctx);
      refreshStatus(ctx);
      ctx.ui.notify(
        driver === "human"
          ? "pear: you're driving. I'll watch, and ask you to talk me through it now and then."
          : "pear: I'm driving. I'll check in with you as I go.",
        "info",
      );
    },
  });

  pi.registerCommand("pear-explain", {
    description: "Talk the agent through what you changed, without waiting",
    handler: async (_args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      if (rt.driver !== "human") {
        ctx.ui.notify(
          "pear: the agent is driving — use /pear-checkpoint to review its work instead.",
          "warning",
        );
        return;
      }

      // Measure on demand: this is also the escape hatch when the watcher has
      // parked, so it must not depend on the watcher having a fresh number.
      const measured = changedLineStats(ctx.cwd);
      if (!measured.ok) {
        ctx.ui.notify(`pear: couldn't read your changes (${measured.detail}).`, "warning");
        return;
      }
      if (measured.stats.files === 0) {
        ctx.ui.notify(NOTHING_TO_EXPLAIN, "info");
        return;
      }

      const measuredPoints = pointsForWorkingTree(measured.stats);
      rt.setWorkingTreeLoad(measuredPoints);
      // The watcher did not take this measurement, so tell it — otherwise it
      // credits nothing at acknowledgement and re-raises the same tree.
      watcher?.observe(measuredPoints);
      startQuiz(
        ctx,
        measured.stats.files,
        measured.stats.insertions,
        measured.stats.deletions,
        true,
      );
    },
  });

  pi.registerCommand("pear-status", {
    description: "Show pear's mode, phase, and review load",
    handler: async (_args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      const snap = rt.checkpoint.snapshot();
      const { files, verified } = rt.filesSinceBaseline();
      ctx.ui.notify(
        `${rt.statusText()}\n` +
          `${snap.files} file(s), ${snap.lines} line(s) → ${snap.points}/${rt.reviewBudget} points (${rt.tier()})\n` +
          `calls: confirmed ${snap.confirmed}, in-flight ${snap.pending}, unknown ${snap.stale}\n` +
          (verified
            ? `${files.length} file(s) changed since last checkpoint`
            : "file list unavailable (not a git repo)"),
        "info",
      );
    },
  });

  pi.registerCommand("pear-checkpoint", {
    description: "Open a checkpoint yourself, without waiting for the agent",
    handler: async (_args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      const { files } = rt.filesSinceBaseline();
      const { text } = await runCheckpoint(ctx, {
        summary: "Checkpoint requested by you (navigator).",
        files,
        next: "(awaiting your direction)",
      });
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("pear-exclusive", {
    description: "Turn off tools from other extensions for this session",
    handler: async (_args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      const dropped = applyExclusive(ctx);
      let persisted = true;
      let detail = "";
      try {
        saveConfig(ctx.cwd, { exclusive: true });
      } catch (e) {
        persisted = false;
        detail = e instanceof ConfigWriteError ? e.message : String(e);
      }
      const what =
        dropped.length === 0 ? "nothing to disable" : `disabled ${dropped.join(", ")}`;
      ctx.ui.notify(
        persisted
          ? `pear: exclusive mode — ${what}.`
          : `pear: ${what} for this session only — NOT persisted: ${detail}`,
        persisted ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("pear-mode", {
    description: `Switch pear's mode: ${MODES.join(" | ")}`,
    handler: async (args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      const trimmed = args.trim();
      let target: Mode | undefined;

      if (trimmed === "") {
        if (!ctx.hasUI) {
          ctx.ui.notify(`pear-mode needs a mode name here: ${MODES.join(" | ")}`, "warning");
          return;
        }
        const picked = await ctx.ui.select("pear mode:", [...MODES]);
        if (picked === undefined) return;
        target = picked as Mode;
      } else if ((MODES as readonly string[]).includes(trimmed)) {
        target = trimmed as Mode;
      } else {
        ctx.ui.notify(`pear: unknown mode "${trimmed}" — expected ${MODES.join(" or ")}`, "error");
        return;
      }

      let persisted = true;
      let detail = "";
      try {
        saveConfig(ctx.cwd, { mode: target });
      } catch (e) {
        persisted = false;
        detail = e instanceof ConfigWriteError ? e.message : String(e);
      }

      // Saving a mode and running it are separate concerns: a scripted
      // `pi -p "/pear-mode agent-driver"` is a legitimate way to set a project
      // up. What we must not do is claim it is active when no human could
      // answer a checkpoint here.
      const runnable = target === "off" || canShowDialogs(ctx);
      // `setMode` drops the plan, so whatever file it was being written to
      // belongs to a round that no longer exists.
      planFile = null;
      rt.setMode(runnable ? target : "off");
      syncPhaseTools();
      syncWatcher(ctx);
      refreshStatus(ctx);

      if (!persisted) {
        ctx.ui.notify(
          `pear: mode set to ${target} for this session only — NOT persisted: ${detail}`,
          "warning",
        );
      } else if (!runnable) {
        ctx.ui.notify(
          `pear: saved mode=${target}, but it needs an interactive session to show checkpoints — ` +
            `this session stays off.`,
          "warning",
        );
      } else {
        ctx.ui.notify(`pear: mode set to ${target}`, "info");
      }
    },
  });

  /**
   * Put a setting into force without restarting the session.
   *
   * `settings` is updated first so the watcher and the nudge read the new value
   * on their next tick; the runtime is then told the parts it owns. Keys that
   * only apply to a fresh session (`planPhase`) change nothing here, which is
   * why the caller says so.
   */
  const applySetting = (ctx: ExtensionContext, key: ConfigKey, value: unknown): void => {
    const rt = runtime;
    if (rt === null) return;
    settings = { ...settings, [key]: value } as Required<PearConfig>;

    switch (key) {
      case "mode":
        // Same rule as /pear-mode: a mode is only run where a human can answer,
        // and the dropped plan takes its filename with it.
        planFile = null;
        rt.setMode(canShowDialogs(ctx) ? (value as Mode) : "off");
        syncPhaseTools();
        syncWatcher(ctx);
        break;
      case "reviewBudget":
        rt.setBudget(value as number);
        break;
      case "allowedReadOnlyCommands":
        rt.setAllowedReadOnlyCommands(value as string[]);
        break;
      case "softFraction":
      case "blockMultiple":
        rt.setTiers(settings.softFraction, settings.blockMultiple);
        break;
      case "statusIcon":
        rt.setStatusIcon(value as boolean);
        break;
      case "exclusive":
        // Turning it on takes effect now; turning it off cannot, because the
        // tools it dropped are gone for this session. The caller says so.
        if (value === true) applyExclusive(ctx);
        break;
      case "nudge":
      case "pollMs":
      case "debounceMs":
      case "maxPollFailures":
        // The watcher takes these at construction, so it is rebuilt. It adopts
        // the current tree as its baseline, exactly as /pear-swap does.
        syncWatcher(ctx);
        break;
      case "planPhase":
        break;
    }
    refreshStatus(ctx);
  };

  /**
   * Persist one accepted value, put it into force, and say what happened.
   *
   * Every path into `/pear-config` ends here, so the card and the argument
   * form cannot disagree about what a change does.
   */
  const commitSetting = (ctx: ExtensionContext, key: ConfigKey, value: unknown): void => {
    let persisted = true;
    let detail = "";
    try {
      saveConfig(ctx.cwd, { [key]: value } as PearConfig);
    } catch (e) {
      persisted = false;
      detail = e instanceof ConfigWriteError ? e.message : String(e);
    }

    applySetting(ctx, key, value);

    const shown = `${key} = ${formatConfigValue(value)}`;
    // Two keys cannot change this session: scoping has already been decided,
    // and tools already dropped cannot be handed back. Saying so is the
    // difference between a setting that looks broken and one that is pending.
    const later = key === "planPhase" || (key === "exclusive" && value === false);
    const laterNote = later ? " (takes effect next session)" : "";
    ctx.ui.notify(
      persisted
        ? `pear: ${shown}${laterNote}`
        : `pear: ${shown} for this session only — NOT persisted: ${detail}`,
      persisted ? "info" : "warning",
    );
  };

  /**
   * Read one typed edit and commit it, or explain why nothing was written.
   *
   * "Nothing changed" is reported rather than saved: adding a command that is
   * already on the list and removing one that never was are both mistakes, and
   * a silent success would look like the edit had gone the other way.
   */
  const applyEdit = (
    ctx: ExtensionContext,
    key: ConfigKey,
    text: string,
    current: unknown,
  ): boolean => {
    const edit = parseConfigEdit(key, text, current);
    if (edit.ok) {
      commitSetting(ctx, key, edit.value);
      return true;
    }
    if (edit.reason === "unchanged") {
      ctx.ui.notify(`pear: ${edit.entries.join(", ")} already on ${key} — nothing changed`, "info");
    } else if (edit.reason === "absent") {
      ctx.ui.notify(`pear: ${edit.entries.join(", ")} is not on ${key} — nothing changed`, "info");
    } else {
      ctx.ui.notify(
        `pear: ${key} wants ${CONFIG_SPECS[key].describe} — "${text}" isn't one`,
        "error",
      );
    }
    return false;
  };

  /**
   * The settings UI: pick a setting, change it, stay on it.
   *
   * It loops back to the same setting after a change so adding three commands
   * is three keystrokes rather than three invocations, and re-reads the file
   * each time so the card always shows what was actually written. Esc steps
   * back out, and Esc at the picker closes.
   */
  const runSettingsUI = async (ctx: ExtensionContext, only?: ConfigKey): Promise<void> => {
    let key = only;
    for (;;) {
      if (key === undefined) {
        const picked = await show(ctx, settingsCard(loadConfig(ctx.cwd).config));
        if (picked === null) return;
        key = picked.key;
      }

      const current = loadConfig(ctx.cwd).config[key];
      const answer = await show(ctx, settingCard(key, current));
      if (answer === null) {
        // Esc means "back", not "quit" — unless this card is all there is.
        if (only !== undefined) return;
        key = undefined;
        continue;
      }

      if (answer.kind === "value") commitSetting(ctx, key, answer.value);
      else if (answer.kind === "edit") applyEdit(ctx, key, answer.text, current);
      else applyEdit(ctx, key, `+${answer.text.replace(/^\+/, "")}`, current);
    }
  };

  pi.registerCommand("pear-config", {
    description: `Change a pear setting: ${CONFIG_KEYS.join(" | ")}`,
    handler: async (args, ctx) => {
      const rt = needRuntime(ctx);
      if (rt === null) return;
      // What is on disk, so the command reports the file it is about to edit
      // rather than a session that may have diverged from it.
      const current = loadConfig(ctx.cwd).config;
      const raw = args.trim();

      if (raw === "") {
        if (!canShowDialogs(ctx)) {
          ctx.ui.notify(
            `pear-config needs a key and a value here. ` +
              CONFIG_KEYS.map((k) => `${k}=${formatConfigValue(current[k])}`).join(", "),
            "warning",
          );
          return;
        }
        await runSettingsUI(ctx);
        return;
      }

      const [first = "", ...rest] = raw.split(" ").filter((t) => t !== "");
      if (!isConfigKey(first)) {
        // Back-compat: /pear-config used to take nothing but a budget.
        if (/^[0-9]+$/.test(raw)) {
          applyEdit(ctx, "reviewBudget", raw, current.reviewBudget);
          return;
        }
        ctx.ui.notify(
          `pear: unknown setting "${first}" — try one of ${CONFIG_KEYS.join(", ")}`,
          "error",
        );
        return;
      }

      const key = first;
      const valueText = rest.join(" ");
      if (valueText !== "") {
        applyEdit(ctx, key, valueText, current[key]);
        return;
      }

      // A key on its own is a request to see it, never an instruction to empty
      // it — which is what a bare `/pear-config allowedReadOnlyCommands` used
      // to do.
      if (!canShowDialogs(ctx)) {
        ctx.ui.notify(
          `pear: ${key} = ${formatConfigValue(current[key])} (wants ${CONFIG_SPECS[key].describe})`,
          "info",
        );
        return;
      }
      await runSettingsUI(ctx, key);
    },
  });
}
