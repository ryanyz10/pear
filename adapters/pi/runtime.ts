/**
 * pear's session logic, with no pi imports.
 *
 * The pi extension is a thin wiring layer over this; porting pear to another
 * harness means re-implementing that layer, not this file. Everything here is
 * synchronous and injectable so the whole state machine is testable without a
 * host.
 *
 * Two rules drive the design:
 *
 * 1. **A hook must never wait for a human.** Blocking decisions are computed
 *    synchronously and returned. Waiting happens inside the checkpoint tool,
 *    which is allowed to take as long as the human needs.
 * 2. **Nothing is ever aborted.** The previous implementation called pi's
 *    `ctx.abort()` when blocking, which killed the agent run so the model never
 *    saw the explanation. Blocks are ordinary tool results here.
 */

import { isReadOnlyBashCommand } from "../../core/bash.ts";
import { createCheckpoint, type Checkpoint, type FileState } from "../../core/checkpoint.ts";
import { gateClosed, type Mode } from "../../core/config.ts";
import {
  BLOCK_STOPPED,
  RESULT_ALREADY_PENDING,
  RESULT_CANCELLED,
  RESULT_CONTINUE,
  RESULT_MODE_OFF,
  RESULT_OFF,
  RESULT_STOP,
  blockOverdue,
  resultSteering,
  statusLine,
} from "../../core/prompts.ts";

/** Tools that can change the working tree. `bash` is classified per-command. */
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export type BlockDecision = { block: true; reason: string } | undefined;

/** What the human chose at a checkpoint, or why there was no choice. */
export type CheckpointOutcome =
  | { kind: "continue" }
  | { kind: "steer"; text: string }
  | { kind: "stop" }
  | { kind: "cancelled" }
  | { kind: "mode-off" };

export type CheckpointResolution = {
  /** Text handed back to the model as the tool result. */
  text: string;
  /** Ask the host to end the agent loop after this tool batch. */
  terminate: boolean;
};

/** A checkpoint awaiting the human. */
export type PendingCheckpoint = {
  resolve: (outcome: CheckpointOutcome) => void;
  promise: Promise<CheckpointOutcome>;
};

export type RuntimeDeps = {
  cwd: string;
  mode: Mode;
  maxChangesPerCheckpoint: number;
  /** Capture current file state; returns null when git is unavailable. */
  captureFiles: () => FileState | null;
  now?: () => number;
};

export type PearRuntime = {
  readonly mode: Mode;
  readonly stopped: boolean;
  readonly checkpoint: Checkpoint;
  isCheckpointPending: () => boolean;

  setMode: (mode: Mode) => void;
  setMaxChanges: (max: number) => void;

  onMutatingToolCall: (toolName: string, callId: string, input: Record<string, unknown>) => BlockDecision;
  onToolResult: (callId: string, isError: boolean) => void;
  /** Terminal run boundary: sweep orphans. Returns the uncheckpointed count. */
  onAgentSettled: () => number;
  /** Genuine user input (not extension-injected) releases a stop. */
  onUserInput: () => void;

  /**
   * Open a checkpoint. Returns either a promise for the human's answer, or an
   * immediate resolution when no checkpoint should happen.
   */
  beginCheckpoint: () => { pending: PendingCheckpoint } | { immediate: CheckpointResolution };
  /** Resolve the open checkpoint, if any. Idempotent; later calls no-op. */
  resolvePending: (outcome: CheckpointOutcome) => void;
  /** Apply an outcome: update state and produce the model-visible result. */
  applyOutcome: (outcome: CheckpointOutcome) => CheckpointResolution;

  statusText: () => string;
  filesSinceBaseline: () => { files: string[]; verified: boolean };
};

export function createRuntime(deps: RuntimeDeps): PearRuntime {
  const now = deps.now ?? (() => Date.now());
  let mode: Mode = deps.mode;
  let maxChanges = deps.maxChangesPerCheckpoint;
  let stopped = false;
  let pending: PendingCheckpoint | null = null;

  const checkpoint = createCheckpoint(deps.captureFiles() ?? new Map());

  /** Re-baseline to the current tree. Called whenever the human acknowledges. */
  const rebaseline = (): void => {
    checkpoint.reset(deps.captureFiles() ?? new Map());
  };

  const isMutating = (toolName: string, input: Record<string, unknown>): boolean => {
    if (!MUTATING_TOOLS.has(toolName)) return false;
    if (toolName !== "bash") return true;
    const command = typeof input.command === "string" ? input.command : "";
    // Unclassifiable commands count as mutating.
    return !isReadOnlyBashCommand(command);
  };

  const applyOutcome = (outcome: CheckpointOutcome): CheckpointResolution => {
    switch (outcome.kind) {
      case "continue":
        rebaseline();
        return { text: RESULT_CONTINUE, terminate: false };

      case "steer":
        // The human saw the (git-verified) change set before typing this, so
        // it counts as acknowledged. Their requested corrections become the
        // next checkpoint's delta.
        rebaseline();
        return { text: resultSteering(outcome.text), terminate: false };

      case "stop":
        rebaseline();
        stopped = true;
        // `terminate` ends the agent loop at the host level; the stop latch
        // below is the guarantee if the host declines (e.g. mixed batch).
        return { text: RESULT_STOP, terminate: true };

      case "cancelled":
        // Deliberately no rebaseline: nothing was acknowledged, so the same
        // files must still appear at the next checkpoint.
        stopped = true;
        return { text: RESULT_CANCELLED, terminate: true };

      case "mode-off":
        return { text: RESULT_MODE_OFF, terminate: false };
    }
  };

  const resolvePending = (outcome: CheckpointOutcome): void => {
    const p = pending;
    if (p === null) return;
    pending = null;
    p.resolve(outcome);
  };

  return {
    get mode() {
      return mode;
    },
    get stopped() {
      return stopped;
    },
    get checkpoint() {
      return checkpoint;
    },
    isCheckpointPending: () => pending !== null,

    setMode(next) {
      if (next === mode) return;
      mode = next;
      stopped = false;
      // An open card belongs to the mode that opened it.
      resolvePending({ kind: "mode-off" });
      checkpoint.reset(next === "agent-driver" ? (deps.captureFiles() ?? new Map()) : new Map());
    },

    setMaxChanges(max) {
      maxChanges = max;
    },

    onMutatingToolCall(toolName, callId, input) {
      if (mode !== "agent-driver") return undefined;
      if (!isMutating(toolName, input)) return undefined;

      // Stop outranks the budget: the human said stop, so the count is moot.
      if (stopped) return { block: true, reason: BLOCK_STOPPED };

      const total = checkpoint.snapshot().total;
      if (gateClosed(total, maxChanges)) {
        return { block: true, reason: blockOverdue(total, maxChanges) };
      }

      checkpoint.admit(callId, toolName, now());
      return undefined;
    },

    onToolResult(callId, isError) {
      checkpoint.settle(callId, !isError);
    },

    onAgentSettled() {
      checkpoint.sweepStale();
      return checkpoint.snapshot().total;
    },

    onUserInput() {
      stopped = false;
    },

    beginCheckpoint() {
      if (mode !== "agent-driver") {
        return { immediate: { text: RESULT_OFF, terminate: false } };
      }
      if (pending !== null) {
        // Reject rather than queue: a second card would race the first for the
        // same answer, and the model should wait for the answer it asked for.
        return { immediate: { text: RESULT_ALREADY_PENDING, terminate: false } };
      }

      let resolve!: (outcome: CheckpointOutcome) => void;
      const promise = new Promise<CheckpointOutcome>((res) => {
        resolve = res;
      });
      pending = { resolve, promise };
      return { pending };
    },

    resolvePending,
    applyOutcome,

    statusText() {
      if (mode !== "agent-driver") return statusLine(mode, 0, maxChanges);
      const total = checkpoint.snapshot().total;
      const flags: string[] = [];
      if (stopped) flags.push("stopped");
      if (pending !== null) flags.push("awaiting you");
      return statusLine(mode, total, maxChanges, flags.length ? flags.join(", ") : undefined);
    },

    filesSinceBaseline() {
      const current = deps.captureFiles();
      if (current === null) return { files: [], verified: false };
      return { files: checkpoint.filesSinceBaseline(current), verified: true };
    },
  };
}
