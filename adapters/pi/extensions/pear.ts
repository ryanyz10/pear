/**
 * pear as a pi extension.
 *
 * This file is the only pi-specific code in the project; everything it calls
 * lives in `core/` or `adapters/pi/runtime.ts`. Porting pear to another
 * harness means rewriting this file alone.
 *
 * API facts relied on here are recorded in `docs/pi-api-notes.md`, verified
 * against the pinned pi version.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { captureGitState } from "../../../core/git.ts";
import {
  ConfigWriteError,
  MAX_CHANGES,
  MIN_CHANGES,
  MODES,
  isValidMaxChanges,
  loadConfig,
  saveConfig,
  type Mode,
} from "../../../core/config.ts";
import {
  AGENT_DRIVER_PERSONA,
  CHECKPOINT_TOOL_DESCRIPTION,
  CHECKPOINT_TOOL_NAME,
  resultCheckpointFailed,
} from "../../../core/prompts.ts";
import { createRuntime, type CheckpointOutcome, type PearRuntime } from "../runtime.ts";
import { renderCheckpointCard, type CardAnswer } from "./checkpoint-card.ts";

const CheckpointParams = Type.Object({
  summary: Type.String({ description: "What you changed and why, in plain language." }),
  files: Type.Array(Type.String(), { description: "Files you touched, so the human can review them." }),
  next: Type.String({ description: "What you plan to do next." }),
});

type CheckpointDetails = {
  summary: string;
  claimedFiles: string[];
  gitFiles: string[];
  verified: boolean;
  answer: string;
};

export default function pear(pi: ExtensionAPI) {
  // `runtime.mode` is the single source of truth for the mode this session is
  // actually running, which can differ from what is on disk (see the headless
  // policy below). Deliberately not mirrored in a second variable.
  let runtime: PearRuntime | null = null;

  const captureFiles = (cwd: string) => () => {
    const state = captureGitState(cwd);
    return state.ok ? state.files : null;
  };

  const refreshStatus = (ctx: { ui: { setStatus: (k: string, t: string | undefined) => void } }) => {
    if (runtime === null) return;
    try {
      ctx.ui.setStatus("pear", runtime.statusText());
    } catch {
      /* status is cosmetic */
    }
  };

  /**
   * `ui.custom` only works in the TUI. `hasUI` is also true in RPC, where it
   * silently no-ops, so tiering on `hasUI` would degrade the checkpoint to
   * nothing. See docs/pi-api-notes.md.
   */
  const canShowCard = (ctx: ExtensionContext) => ctx.mode === "tui";
  const canShowDialogs = (ctx: ExtensionContext) => ctx.hasUI;

  // ---------------------------------------------------------------- session

  pi.on("session_start", (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);

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

    // Headless fail-closed: never approve changes without a human present.
    let startMode: Mode = loaded.config.mode;
    if (startMode === "agent-driver" && !canShowDialogs(ctx)) {
      ctx.ui.notify(
        "pear: agent-driver needs an interactive session to show checkpoints — running off for this session. " +
          "Config unchanged.",
        "warning",
      );
      startMode = "off";
    }

    runtime = createRuntime({
      cwd: ctx.cwd,
      mode: startMode,
      maxChangesPerCheckpoint: loaded.config.maxChangesPerCheckpoint,
      captureFiles: captureFiles(ctx.cwd),
    });
    refreshStatus(ctx);
  });

  // A pending card must not outlive the session (quit, reload, fork, ...).
  pi.on("session_shutdown", () => {
    runtime?.resolvePending({ kind: "cancelled" });
  });

  // --------------------------------------------------------------- persona

  pi.on("before_agent_start", (event) => {
    if (runtime === null || runtime.mode !== "agent-driver") return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${AGENT_DRIVER_PERSONA}` };
  });

  // ------------------------------------------------------------ the gate

  pi.on("tool_call", (event, ctx) => {
    if (runtime === null) return undefined;
    const decision = runtime.onMutatingToolCall(
      event.toolName,
      event.toolCallId,
      event.input as Record<string, unknown>,
    );
    refreshStatus(ctx);
    // NOTE: no ctx.abort(). Returning the block is what lets the model read
    // the reason and recover; aborting is what broke the previous version.
    return decision;
  });

  pi.on("tool_result", (event, ctx) => {
    if (runtime === null) return;
    runtime.onToolResult(event.toolCallId, event.isError);
    refreshStatus(ctx);
  });

  /**
   * Only genuine user input clears a stop. `source === "extension"` is a
   * message injected by an extension via sendUserMessage, which must not be
   * able to override the human.
   */
  pi.on("input", (event, ctx) => {
    if (runtime === null) return undefined;
    if (event.source !== "extension") {
      runtime.onUserInput();
      refreshStatus(ctx);
    }
    return undefined;
  });

  /**
   * `agent_settled` — not `agent_end` — is the terminal boundary: pi may still
   * auto-retry or run a queued continuation after `agent_end`.
   */
  pi.on("agent_settled", (_event, ctx) => {
    if (runtime === null || runtime.mode !== "agent-driver") return;
    const outstanding = runtime.onAgentSettled();
    if (outstanding > 0) {
      ctx.ui.notify(
        `pear: ${outstanding} change${outstanding === 1 ? "" : "s"} not yet checkpointed. ` +
          `Run /pear-checkpoint to review them.`,
        "info",
      );
    }
    refreshStatus(ctx);
  });

  // ------------------------------------------------------ checkpoint tool

  /** Ask the human, by whatever means this host supports right now. */
  async function askHuman(ctx: ExtensionContext, view: {
    summary: string;
    next: string;
    claimedFiles: string[];
    gitFiles: string[];
    verified: boolean;
    verifyDetail?: string;
  }): Promise<CheckpointOutcome> {
    if (canShowCard(ctx)) {
      const answer: CardAnswer | null = await ctx.ui.custom((tui, theme, _kb, done) =>
        renderCheckpointCard(tui, theme, done, view),
      );
      if (answer === null) return { kind: "cancelled" };
      if (answer.kind === "steer") return { kind: "steer", text: answer.text };
      return answer.kind === "stop" ? { kind: "stop" } : { kind: "continue" };
    }

    // RPC: ui.custom no-ops, but dialogs work. Only offer outcomes we can
    // actually complete here — an unavailable option must not silently
    // become "cancelled".
    const CONTINUE = "continue — looks good, keep going";
    const STEER = "make changes — I'll type what to do";
    const STOP = "stop — I'm taking over";
    const options = [CONTINUE, STEER, STOP];

    const picked = await ctx.ui.select(
      `pear checkpoint: ${view.summary}\nNext: ${view.next}`,
      options,
    );
    if (picked === undefined) return { kind: "cancelled" };
    if (picked === STOP) return { kind: "stop" };
    if (picked === STEER) {
      const text = await ctx.ui.input("What should I do instead?");
      if (text === undefined || text.trim() === "") return { kind: "cancelled" };
      return { kind: "steer", text };
    }
    return { kind: "continue" };
  }

  /** Shared by the tool and the /pear-checkpoint command. */
  async function runCheckpoint(
    ctx: ExtensionContext,
    claimed: { summary: string; files: string[]; next: string },
  ): Promise<{ text: string; terminate: boolean; details: CheckpointDetails }> {
    const rt = runtime;
    if (rt === null) {
      return {
        text: resultCheckpointFailed("pear is not initialised"),
        terminate: false,
        details: { summary: claimed.summary, claimedFiles: claimed.files, gitFiles: [], verified: false, answer: "error" },
      };
    }

    const started = rt.beginCheckpoint();
    if ("immediate" in started) {
      return {
        text: started.immediate.text,
        terminate: started.immediate.terminate,
        details: {
          summary: claimed.summary,
          claimedFiles: claimed.files,
          gitFiles: [],
          verified: false,
          answer: "not-run",
        },
      };
    }

    const { files: gitFiles, verified } = rt.filesSinceBaseline();

    let outcome: CheckpointOutcome;
    try {
      // Race the human against every way this can be torn down. Whichever
      // resolves first wins; the loser is a no-op because resolvePending and
      // the promise itself are both idempotent.
      const answered = askHuman(ctx, {
        summary: claimed.summary,
        next: claimed.next,
        claimedFiles: claimed.files,
        gitFiles,
        verified,
      }).then((o) => {
        rt.resolvePending(o);
        return o;
      });
      outcome = await Promise.race([started.pending.promise, answered]);
    } catch (e) {
      // A UI failure must not leave the card pending or the baseline moved.
      rt.resolvePending({ kind: "cancelled" });
      const detail = e instanceof Error ? e.message : String(e);
      const resolution = rt.applyOutcome({ kind: "cancelled" });
      return {
        text: `${resultCheckpointFailed(detail)}\n\n${resolution.text}`,
        terminate: resolution.terminate,
        details: { summary: claimed.summary, claimedFiles: claimed.files, gitFiles, verified, answer: "error" },
      };
    }

    const resolution = rt.applyOutcome(outcome);
    refreshStatus(ctx);
    return {
      text: resolution.text,
      terminate: resolution.terminate,
      details: {
        summary: claimed.summary,
        claimedFiles: claimed.files,
        gitFiles,
        verified,
        answer: outcome.kind,
      },
    };
  }

  pi.registerTool({
    name: CHECKPOINT_TOOL_NAME,
    label: "Checkpoint",
    description: CHECKPOINT_TOOL_DESCRIPTION,
    parameters: CheckpointParams,
    // Keeps the card from opening while sibling mutations are still writing.
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const onAbort = () => runtime?.resolvePending({ kind: "cancelled" });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const { text, terminate, details } = await runCheckpoint(ctx, {
          summary: params.summary,
          files: params.files,
          next: params.next,
        });
        return {
          content: [{ type: "text" as const, text }],
          details,
          terminate,
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    renderCall(args, theme) {
      const files = Array.isArray(args.files) ? args.files : [];
      const head = theme.fg("toolTitle", theme.bold("checkpoint "));
      const body = theme.fg("muted", String(args.summary ?? ""));
      const tail = files.length ? theme.fg("dim", `\n  ${files.length} file(s)`) : "";
      return new Text(head + body + tail, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as CheckpointDetails | undefined;
      if (d === undefined) return new Text("", 0, 0);
      const label =
        d.answer === "continue"
          ? theme.fg("success", "✓ continue")
          : d.answer === "steer"
            ? theme.fg("accent", "✎ steering")
            : d.answer === "stop"
              ? theme.fg("warning", "■ stop")
              : theme.fg("dim", d.answer);
      return new Text(label, 0, 0);
    },
  });

  // ------------------------------------------------------------- commands

  pi.registerCommand("pear-status", {
    description: "Show pear's mode and checkpoint budget",
    handler: async (_args, ctx) => {
      if (runtime === null) {
        ctx.ui.notify("pear: not initialised", "warning");
        return;
      }
      const snap = runtime.checkpoint.snapshot();
      const { files, verified } = runtime.filesSinceBaseline();
      ctx.ui.notify(
        `${runtime.statusText()}\n` +
          `confirmed ${snap.confirmed}, in-flight ${snap.pending}, unknown ${snap.stale}\n` +
          (verified ? `${files.length} file(s) changed since last checkpoint` : "file list unavailable (not a git repo)"),
        "info",
      );
    },
  });

  pi.registerCommand("pear-checkpoint", {
    description: "Open a checkpoint yourself, without waiting for the agent",
    handler: async (_args, ctx) => {
      if (runtime === null) {
        ctx.ui.notify("pear: not initialised", "warning");
        return;
      }
      const { files } = runtime.filesSinceBaseline();
      const { text } = await runCheckpoint(ctx, {
        summary: "Checkpoint requested by you (navigator).",
        files,
        next: "(awaiting your direction)",
      });
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("pear-mode", {
    description: `Switch pear's mode: ${MODES.join(" | ")}`,
    handler: async (args, ctx) => {
      if (runtime === null) {
        ctx.ui.notify("pear: not initialised", "warning");
        return;
      }
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
      const runnable = target !== "agent-driver" || canShowDialogs(ctx);
      runtime.setMode(runnable ? target : "off");
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

  pi.registerCommand("pear-config", {
    description: "Set how many changes may pass between checkpoints",
    handler: async (args, ctx) => {
      if (runtime === null) {
        ctx.ui.notify("pear: not initialised", "warning");
        return;
      }
      const current = loadConfig(ctx.cwd).config;
      let raw = args.trim();

      if (raw === "") {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `pear-config needs a number here (${MIN_CHANGES}-${MAX_CHANGES}); currently ${current.maxChangesPerCheckpoint}`,
            "warning",
          );
          return;
        }
        const typed = await ctx.ui.input(
          `Changes allowed between checkpoints (${MIN_CHANGES}-${MAX_CHANGES}), currently ${current.maxChangesPerCheckpoint}:`,
        );
        if (typed === undefined) return;
        raw = typed.trim();
      }

      const value = Number(raw);
      if (!isValidMaxChanges(value)) {
        ctx.ui.notify(
          `pear: need a whole number between ${MIN_CHANGES} and ${MAX_CHANGES}`,
          "error",
        );
        return;
      }

      let persisted = true;
      let detail = "";
      try {
        saveConfig(ctx.cwd, { maxChangesPerCheckpoint: value });
      } catch (e) {
        persisted = false;
        detail = e instanceof ConfigWriteError ? e.message : String(e);
      }

      runtime.setMaxChanges(value);
      refreshStatus(ctx);
      ctx.ui.notify(
        persisted
          ? `pear: up to ${value} change(s) between checkpoints`
          : `pear: set to ${value} for this session only — NOT persisted: ${detail}`,
        persisted ? "info" : "warning",
      );
    },
  });
}
