import { overBudget, type BudgetCfg } from "./config.ts";

export const STEERING_CONTRACT = "NOT EXECUTED — human steering: ";
export const ACK_CONTRACT =
  "NOT EXECUTED — checkpoint acknowledged; re-issue this call and continue as planned";

export type CheckpointSnapshot = {
  baselineLines: number;
  confirmed: number;
  pending: number;
  rebasePending: boolean;
};

export type Checkpoint = {
  check: (stats: { lines: number }) => boolean;
  reserve: (callId: string) => void;
  settle: (callId: string, ok: boolean) => void;
  resetBaseline: (lines: number | null) => void;
  finishRebase: (lines: number) => void;
  abandonRebase: () => void;
  getBaselineLines: () => number;
  snapshot: () => CheckpointSnapshot;
};

/** Build the checkpoint summary. */
export function buildSummary(
  label: string,
  delta: { lines: number; mutations: number },
  files: string[],
): string {
  const visibleFiles = files.slice(0, 12);
  const filePart = visibleFiles.length
    ? `\nfiles:\n${visibleFiles.map((file) => `- ${file}`).join("\n")}${files.length > 12 ? "\n…" : ""}`
    : "";
  return (
    `── checkpoint ──\n` +
    `+${delta.lines} lines / ${delta.mutations} mutations since last look` +
    filePart +
    `\nabout to: ${label}\n` +
    `Enter = continue, or type steering: `
  );
}

export function createCheckpoint(cfg: BudgetCfg, initialLines = 0): Checkpoint {
  let baselineLines = initialLines;
  let confirmed = 0;
  let pending = 0;
  let rebasePending = false;
  const reservations = new Map<string, true>();

  const effectiveMutations = () => confirmed + pending;

  return {
    check(stats) {
      return overBudget(
        {
          lines: rebasePending ? baselineLines : stats.lines,
          mutations: effectiveMutations(),
        },
        { lines: baselineLines, mutations: 0 },
        cfg,
      );
    },

    reserve(callId) {
      if (reservations.has(callId)) return;
      reservations.set(callId, true);
      pending++;
    },

    settle(callId, ok) {
      if (!reservations.has(callId)) return;
      reservations.delete(callId);
      pending--;
      if (ok) confirmed++;
    },

    resetBaseline(lines) {
      confirmed = 0;
      pending = 0;
      reservations.clear();
      if (lines === null) {
        rebasePending = true;
      } else {
        baselineLines = lines;
        rebasePending = false;
      }
    },

    finishRebase(lines) {
      if (!rebasePending) return;
      baselineLines = lines;
      rebasePending = false;
    },

    abandonRebase() {
      rebasePending = false;
    },

    getBaselineLines: () => baselineLines,

    snapshot: () => ({ baselineLines, confirmed, pending, rebasePending }),
  };
}
