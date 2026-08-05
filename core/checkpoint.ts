import { checkpointDue } from "./config.ts";

export const STEERING_CONTRACT = "NOT EXECUTED — human steering: ";
export const ACK_CONTRACT =
  "NOT EXECUTED — checkpoint acknowledged; re-issue this call and continue as planned";

export type CheckpointSnapshot = { baselineTime: number; confirmed: number; pending: number };

export type Checkpoint = {
  check: (now: number) => boolean;
  reserve: (callId: string) => void;
  settle: (callId: string, ok: boolean) => void;
  resetBaseline: (now: number, fileHashes: Map<string, string>) => void;
  getBaselineTime: () => number;
  filesSinceBaseline: (currentFileHashes: Map<string, string>) => string[];
  snapshot: () => CheckpointSnapshot;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

/**
 * Plain-object equivalent of `Checkpoint.filesSinceBaseline`, for
 * JSON-persisted callers (`adapters/shared/hook-checkpoint.ts`) that cannot
 * store a `Map`. Returns every path in `current` whose hash is missing from
 * or differs from `baseline` — new files, files edited again since the last
 * checkpoint, and files edited for the first time this batch. A path with an
 * identical hash in both is excluded.
 */
export function filesSincePersistedBaseline(
  baseline: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return Object.keys(current).filter((path) => current[path] !== baseline[path]);
}

/** Build the checkpoint summary. */
export function buildSummary(
  label: string,
  delta: { elapsedMs: number; changes: number },
  files: string[],
): string {
  const visibleFiles = files.slice(0, 12);
  const filePart = visibleFiles.length
    ? `\nfiles:\n${visibleFiles.map((file) => `- ${file}`).join("\n")}${files.length > 12 ? "\n…" : ""}`
    : "";
  return (
    `── checkpoint ──\n` +
    `${formatElapsed(delta.elapsedMs)} elapsed / ${delta.changes} changes since last look` +
    filePart +
    `\nabout to: ${label}\n` +
    `Enter = continue, or type steering: \n` +
    `Before continuing: tell the human the big-picture goal of this batch and what you plan to do next, then continue.`
  );
}

export function createCheckpoint(
  cfg: { checkpointSeconds: number; maxChangesPerCheckpoint: number },
  initialTime: number,
  initialFileHashes: Map<string, string>,
): Checkpoint {
  let baselineTime = initialTime;
  let baselineFileHashes = new Map(initialFileHashes);
  let confirmed = 0;
  let pending = 0;
  const reservations = new Set<string>();

  return {
    check(now) {
      return checkpointDue({ elapsedMs: now - baselineTime, changes: confirmed + pending }, cfg);
    },

    reserve(callId) {
      if (reservations.has(callId)) return;
      reservations.add(callId);
      pending++;
    },

    settle(callId, ok) {
      if (!reservations.has(callId)) return;
      reservations.delete(callId);
      pending--;
      if (ok) confirmed++;
    },

    resetBaseline(now, fileHashes) {
      baselineTime = now;
      baselineFileHashes = new Map(fileHashes);
      confirmed = 0;
      pending = 0;
      reservations.clear();
    },

    getBaselineTime: () => baselineTime,

    filesSinceBaseline(currentFileHashes) {
      return filesSincePersistedBaseline(
        Object.fromEntries(baselineFileHashes),
        Object.fromEntries(currentFileHashes),
      );
    },

    snapshot: () => ({ baselineTime, confirmed, pending }),
  };
}
