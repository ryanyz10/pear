/**
 * Checkpoint accounting: how many mutating tool calls have happened since the
 * human last looked, and which files changed in that window.
 *
 * The whole design goal is that this can only ever err toward *more* human
 * oversight, never less:
 *
 * - A call is counted when it is admitted, not when it succeeds, so an
 *   in-flight call already counts toward the gate.
 * - A call that fails frees its budget (nothing changed, so nothing to review).
 * - A call that never reports back (aborted turn, crash) is **not** assumed to
 *   have succeeded and is **not** assumed to have done nothing: it becomes
 *   `stale`, which still counts. Worst case the human is asked to look
 *   slightly early.
 * - Tool call ids are the only correlation handle a result carries, and the
 *   host does not promise they are unique forever. Rather than rely on that,
 *   reuse of a live id **fails closed**: the older entry is settled as
 *   confirmed before the new one is admitted.
 *
 * `pear_checkpoint` itself is never admitted here, so opening a checkpoint can
 * never be blocked by checkpoint accounting. That is what makes the loop
 * impossible to wedge.
 */

/** Why a pending entry stopped being pending. */
export type SettleOutcome = "confirmed" | "failed" | "stale" | "reused";

export type PendingEntry = {
  toolName: string;
  /** Monotonic admission order, for stable reporting/debugging. */
  seq: number;
  admittedAt: number;
};

export type CheckpointSnapshot = {
  /** Completed successfully since the last reset. */
  confirmed: number;
  /** Admitted and still awaiting a result. */
  pending: number;
  /** Admitted but never reported back; conservatively still counted. */
  stale: number;
  /** What the gate compares against `maxChangesPerCheckpoint`. */
  total: number;
};

export type Checkpoint = {
  /**
   * Record an admitted mutating call. Returns the outcome of any prior entry
   * that had to be force-settled because its id was reused.
   */
  admit: (callId: string, toolName: string, now: number) => void;
  /** Settle a call by id. Unknown ids are ignored (never-admitted or already settled). */
  settle: (callId: string, ok: boolean) => SettleOutcome | undefined;
  /**
   * Reclassify everything still pending as `stale`. Call only at a boundary
   * where the host guarantees nothing is in flight.
   */
  sweepStale: () => number;
  /** Clear all counters and adopt a new file baseline. */
  reset: (fileBaseline: FileState) => void;
  snapshot: () => CheckpointSnapshot;
  /** Paths whose state differs from the baseline captured at the last reset. */
  filesSinceBaseline: (current: FileState) => string[];
  /** The baseline itself, for diagnostics. */
  baseline: () => FileState;
};

/** path -> opaque state token (see core/git.ts for the token grammar). */
export type FileState = Map<string, string>;

/**
 * Tokens that must always compare as "changed", regardless of whether the
 * baseline and current tokens happen to be byte-identical. Used for files we
 * could not read: two failed reads look the same but tell us nothing, so we
 * must not conclude the file is unchanged.
 */
export const UNCERTAIN_TOKEN_PREFIX = "unreadable:";

export function isUncertain(token: string | undefined): boolean {
  return token !== undefined && token.startsWith(UNCERTAIN_TOKEN_PREFIX);
}

/**
 * Paths that differ between two captures.
 *
 * A path is reported when it is present in only one capture, when its tokens
 * differ, or when either side is uncertain (see `isUncertain`).
 */
export function diffFileState(baseline: FileState, current: FileState): string[] {
  const changed: string[] = [];
  for (const [path, token] of current) {
    const before = baseline.get(path);
    if (before === undefined || before !== token || isUncertain(token) || isUncertain(before)) {
      changed.push(path);
    }
  }
  for (const [path] of baseline) {
    if (!current.has(path)) changed.push(path);
  }
  changed.sort();
  return changed;
}

export function createCheckpoint(initialBaseline: FileState = new Map()): Checkpoint {
  let baseline: FileState = new Map(initialBaseline);
  let confirmed = 0;
  let stale = 0;
  let seq = 0;
  const pending = new Map<string, PendingEntry>();

  const finish = (callId: string, entry: PendingEntry, outcome: SettleOutcome): SettleOutcome => {
    pending.delete(callId);
    if (outcome === "confirmed") confirmed++;
    else if (outcome === "stale") stale++;
    else if (outcome === "reused") confirmed++;
    // "failed" frees the budget entirely: nothing changed on disk.
    return outcome;
  };

  return {
    admit(callId, toolName, now) {
      const prior = pending.get(callId);
      if (prior !== undefined) {
        // Fail closed: we cannot tell a reused id from a duplicate admission,
        // so keep the old call's cost rather than lose track of it.
        finish(callId, prior, "reused");
      }
      pending.set(callId, { toolName, seq: seq++, admittedAt: now });
    },

    settle(callId, ok) {
      const entry = pending.get(callId);
      if (entry === undefined) return undefined;
      return finish(callId, entry, ok ? "confirmed" : "failed");
    },

    sweepStale() {
      const n = pending.size;
      for (const [callId, entry] of [...pending]) {
        finish(callId, entry, "stale");
      }
      return n;
    },

    reset(fileBaseline) {
      baseline = new Map(fileBaseline);
      confirmed = 0;
      stale = 0;
      pending.clear();
      // `seq` deliberately keeps counting: it is an admission ordinal, not a count.
    },

    snapshot() {
      return {
        confirmed,
        pending: pending.size,
        stale,
        total: confirmed + pending.size + stale,
      };
    },

    filesSinceBaseline(current) {
      return diffFileState(baseline, current);
    },

    baseline() {
      return new Map(baseline);
    },
  };
}
