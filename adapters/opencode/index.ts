import { buildSummary, createCheckpoint, type Checkpoint } from "../../core/checkpoint.ts";
import { DEFAULTS } from "../../core/config.ts";
import {
  changedFiles,
  changedLines,
  diffText,
  gitOk,
  stateHash,
} from "../../core/git.ts";
import { createScheduler, type Scheduler } from "../../core/navigate.ts";
import { blockMessage } from "../shared/conversational.ts";
import { appendFindings, ensurePearDir } from "../shared/daemon.ts";

const MUTATING = new Set(["write", "edit", "bash"]);

type ToolCtx = {
  tool?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
  callId?: string;
  id?: string;
  error?: unknown;
};

function toolFrom(ctx: ToolCtx) {
  return (ctx.tool ?? ctx.toolName ?? "").toLowerCase();
}

function inputFrom(ctx: ToolCtx): Record<string, unknown> {
  return ctx.input ?? ctx.args ?? {};
}

function callIdFrom(ctx: ToolCtx): string {
  return String(ctx.callId ?? ctx.id ?? `${Date.now()}`);
}

function toolLabel(tool: string, input: Record<string, unknown>): string {
  if (tool === "bash") return `bash ${String(input.command ?? "").slice(0, 80)}`;
  if (typeof input.path === "string") return `${tool} ${input.path}`;
  return tool;
}

export const PearPlugin = async ({
  client,
  directory,
}: {
  client: { session?: { create?: (opts: Record<string, unknown>) => Promise<unknown> } };
  directory: string;
}) => {
  const isGit = gitOk(directory);
  const checkpoint: Checkpoint = createCheckpoint(
    { pauseLines: DEFAULTS.pauseLines, pauseEdits: DEFAULTS.pauseEdits },
    0,
  );

  const safeLines = (): number => {
    if (!isGit) return 0;
    try {
      return changedLines(directory);
    } catch {
      return checkpoint.getBaselineLines();
    }
  };

  const safeFiles = (): string[] => {
    if (!isGit) return [];
    try {
      return changedFiles(directory);
    } catch {
      return [];
    }
  };

  checkpoint.resetBaseline(isGit ? safeLines() : 0);

  let scheduler: Scheduler | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let awaitingSteering = false;

  if (isGit) {
    ensurePearDir(directory);
    scheduler = createScheduler(
      {
        minLines: DEFAULTS.minLines,
        intervalSeconds: DEFAULTS.intervalSeconds,
        debounceSeconds: DEFAULTS.debounceSeconds,
      },
      {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        getChangedLines: () => safeLines(),
        getDiffText: () => diffText(directory),
        runReview: async (diff) => {
          const stub = `── navigator (stub) ──\n${diff.slice(0, 400)}`;
          if (client?.session?.create) {
            try {
              await client.session.create({ message: stub });
            } catch {
              appendFindings(directory, stub);
            }
          } else {
            appendFindings(directory, stub);
          }
          return { ok: true };
        },
        onOutput: (text) => appendFindings(directory, text),
      },
    );
    pollTimer = setInterval(() => {
      try {
        scheduler?.notify(stateHash(directory));
      } catch {
        /* transient git error */
      }
    }, 2000);
  }

  const gateBefore = (ctx: ToolCtx) => {
    const tool = toolFrom(ctx);
    if (!MUTATING.has(tool)) return;

    if (awaitingSteering) {
      const snap = checkpoint.snapshot();
      checkpoint.resetBaseline(
        isGit ? (snap.pending > 0 ? null : safeLines()) : 0,
      );
      awaitingSteering = false;
    }

    const lines = safeLines();
    if (!checkpoint.check({ lines })) {
      checkpoint.reserve(callIdFrom(ctx));
      return;
    }

    const snap = checkpoint.snapshot();
    const summary = buildSummary(
      toolLabel(tool, inputFrom(ctx)),
      {
        lines: snap.rebasePending ? 0 : lines - snap.baselineLines,
        mutations: snap.confirmed + snap.pending,
      },
      safeFiles(),
    );
    awaitingSteering = true;
    throw new Error(blockMessage(summary));
  };

  const settleAfter = (ctx: ToolCtx) => {
    const tool = toolFrom(ctx);
    if (!MUTATING.has(tool)) return;
    checkpoint.settle(callIdFrom(ctx), !ctx.error);
    const snap = checkpoint.snapshot();
    if (snap.rebasePending) {
      try {
        checkpoint.finishRebase(safeLines());
      } catch {
        checkpoint.abandonRebase();
      }
    }
  };

  return {
    "session.created": () => {
      scheduler?.setAgentActive(true);
    },
    "session.ended": () => {
      if (pollTimer) clearInterval(pollTimer);
      scheduler?.stop();
    },
    "tool.execute.before": gateBefore,
    "tool.execute.after": settleAfter,
  };
};

export default PearPlugin;
