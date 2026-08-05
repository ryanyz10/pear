import { buildSummary, createCheckpoint, type Checkpoint } from "../../core/checkpoint.ts";
import { resolveConfig } from "../../core/config.ts";
import { changedLines, diffText, fileStateHashes, gitOk, quickStateHash } from "../../core/git.ts";
import { createScheduler, type Scheduler } from "../../core/navigate.ts";
import { blockMessage } from "../shared/conversational.ts";
import { appendFindings, ensurePearDir } from "../shared/daemon.ts";
import { homedir } from "node:os";

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
  const cfg = resolveConfig(directory, homedir());

  const safeFileHashes = (): Map<string, string> => {
    if (!isGit) return new Map();
    try {
      return fileStateHashes(directory);
    } catch {
      return new Map();
    }
  };

  let scheduler: Scheduler | null = null;
  let checkpoint: Checkpoint | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let awaitingSteering = false;

  if (cfg.mode === "agent-driver") {
    checkpoint = createCheckpoint(
      { checkpointSeconds: cfg.checkpointSeconds, maxChangesPerCheckpoint: cfg.maxChangesPerCheckpoint },
      Date.now(),
      safeFileHashes(),
    );
  } else if (cfg.mode === "human-driver" && isGit) {
    ensurePearDir(directory);
    scheduler = createScheduler(
      { minLines: cfg.minLines, intervalSeconds: cfg.intervalSeconds, debounceSeconds: cfg.debounceSeconds },
      {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
        getChangedLines: () => changedLines(directory),
        getDiffText: () => diffText(directory),
        runReview: async (diff) => {
          // ── navigator (stub) ── no real model call for OpenCode yet; this
          // migrates to the mode/checkpoint contracts without implementing a
          // real two-stage review — that was already out of scope before this
          // rewrite.
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
  }

  const gateBefore = (ctx: ToolCtx) => {
    if (!checkpoint) return;
    const tool = toolFrom(ctx);
    if (!MUTATING.has(tool)) return;

    if (awaitingSteering) {
      checkpoint.resetBaseline(Date.now(), safeFileHashes());
      awaitingSteering = false;
    }

    if (!checkpoint.check(Date.now())) {
      checkpoint.reserve(callIdFrom(ctx));
      return;
    }

    const snap = checkpoint.snapshot();
    const summary = buildSummary(
      toolLabel(tool, inputFrom(ctx)),
      { elapsedMs: Date.now() - snap.baselineTime, changes: snap.confirmed + snap.pending },
      checkpoint.filesSinceBaseline(safeFileHashes()),
    );
    awaitingSteering = true;
    checkpoint.resetBaseline(Date.now(), safeFileHashes());
    throw new Error(blockMessage(summary));
  };

  const settleAfter = (ctx: ToolCtx) => {
    if (!checkpoint) return;
    const tool = toolFrom(ctx);
    if (!MUTATING.has(tool)) return;
    checkpoint.settle(callIdFrom(ctx), !ctx.error);
  };

  return {
    "session.created": () => {
      if (scheduler && pollTimer == null) {
        pollTimer = setInterval(() => {
          try {
            scheduler?.notify(quickStateHash(directory));
          } catch {
            /* transient git error */
          }
        }, 2000);
      }
    },
    "session.ended": () => {
      clearInterval(pollTimer as NodeJS.Timeout);
      pollTimer = null;
      scheduler?.stop();
    },
    "tool.execute.before": gateBefore,
    "tool.execute.after": settleAfter,
  };
};

export default PearPlugin;
