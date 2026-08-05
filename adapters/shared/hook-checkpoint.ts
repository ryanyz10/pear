import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSummary, filesSincePersistedBaseline } from "../../core/checkpoint.ts";
import { checkpointDue, resolveConfig, type PearConfig } from "../../core/config.ts";
import { fileStateHashes, gitOk } from "../../core/git.ts";
import { blockMessage } from "./conversational.ts";
import { ensurePearDir } from "./daemon.ts";

export type PersistedCheckpoint = {
  baselineTime: number;
  fileHashes: Record<string, string>;
  confirmed: number;
  pending: number;
  reservations: string[];
  awaitingSteering: boolean;
};

export type GateInput = {
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type GateResult =
  | { action: "allow"; state: PersistedCheckpoint }
  | { action: "deny"; summary: string; block: string; state: PersistedCheckpoint };

const FILE = "checkpoint.json";

function statePath(cwd: string): string {
  return join(cwd, ".pear", FILE);
}

function safeFileHashes(cwd: string): Record<string, string> {
  if (!gitOk(cwd)) return {};
  try {
    return Object.fromEntries(fileStateHashes(cwd));
  } catch {
    return {};
  }
}

function freshState(currentHashes: Record<string, string>, now: number): PersistedCheckpoint {
  return {
    baselineTime: now,
    fileHashes: currentHashes,
    confirmed: 0,
    pending: 0,
    reservations: [],
    awaitingSteering: false,
  };
}

function defaultState(cwd: string): PersistedCheckpoint {
  return freshState(safeFileHashes(cwd), Date.now());
}

export function loadState(cwd: string): PersistedCheckpoint {
  ensurePearDir(cwd);
  try {
    const raw = JSON.parse(readFileSync(statePath(cwd), "utf8")) as Partial<PersistedCheckpoint>;
    if (typeof raw.baselineTime !== "number" || typeof raw.fileHashes !== "object" || raw.fileHashes === null) {
      // Legacy (line-based) or malformed state — start fresh; the next
      // successful gateTool call persists the new shape.
      return defaultState(cwd);
    }
    return {
      baselineTime: raw.baselineTime,
      fileHashes: raw.fileHashes,
      confirmed: raw.confirmed ?? 0,
      pending: raw.pending ?? 0,
      reservations: Array.isArray(raw.reservations) ? raw.reservations : [],
      awaitingSteering: raw.awaitingSteering ?? false,
    };
  } catch {
    return defaultState(cwd);
  }
}

export function saveState(cwd: string, state: PersistedCheckpoint): void {
  ensurePearDir(cwd);
  writeFileSync(statePath(cwd), JSON.stringify(state, null, 2));
}

export function toolLabel(event: GateInput): string {
  const input = event.input;
  const name = event.toolName.toLowerCase();
  if (name === "bash" || name === "shell") {
    return `bash ${String(input.command ?? "").slice(0, 80)}`;
  }
  const path = input.path ?? input.file_path ?? input.filePath;
  if (typeof path === "string") return `${event.toolName} ${path}`;
  return event.toolName;
}

function checkBudget(
  state: PersistedCheckpoint,
  now: number,
  cfg: { checkpointSeconds: number; maxChangesPerCheckpoint: number },
): boolean {
  return checkpointDue({ elapsedMs: now - state.baselineTime, changes: state.confirmed + state.pending }, cfg);
}

function delta(state: PersistedCheckpoint, now: number) {
  return { elapsedMs: now - state.baselineTime, changes: state.confirmed + state.pending };
}



export function reserve(state: PersistedCheckpoint, callId: string): PersistedCheckpoint {
  if (state.reservations.includes(callId)) return state;
  return {
    ...state,
    pending: state.pending + 1,
    reservations: [...state.reservations, callId],
  };
}

export function settle(
  state: PersistedCheckpoint,
  callId: string,
  ok: boolean,
): PersistedCheckpoint {
  if (!state.reservations.includes(callId)) return state;
  return {
    ...state,
    reservations: state.reservations.filter((id) => id !== callId),
    pending: state.pending - 1,
    confirmed: ok ? state.confirmed + 1 : state.confirmed,
  };
}

/**
 * Clears stale reservations left over at turn end (e.g. a tool call whose
 * post-tool-use hook never fired for this turn). Deliberately leaves
 * `baselineTime`, `fileHashes`, and `awaitingSteering` untouched — those are
 * only ever reset together, by `gateTool` itself: once immediately on
 * denial (baseline advances to the moment of denial) and again on the next
 * call after steering (re-anchoring to the moment work actually resumes, so
 * the human's response latency never counts against the next checkpoint).
 */
export function sweepTurnEnd(state: PersistedCheckpoint): PersistedCheckpoint {
  if (state.pending === 0 && state.reservations.length === 0) return state;
  return { ...state, pending: 0, reservations: [] };
}

export function gateTool(
  cwd: string,
  event: GateInput,
  cfg?: Pick<Required<PearConfig>, "mode" | "checkpointSeconds" | "maxChangesPerCheckpoint">,
): GateResult {
  const effectiveCfg = cfg ?? resolveConfig(cwd, homedir());

  if (effectiveCfg.mode !== "agent-driver") {
    return { action: "allow", state: loadState(cwd) };
  }

  let state = loadState(cwd);
  const now = Date.now();

  if (state.awaitingSteering) {
    state = freshState(safeFileHashes(cwd), now);
    saveState(cwd, state);
  }

  if (!checkBudget(state, now, effectiveCfg)) {
    const next = reserve(state, event.callId);
    saveState(cwd, next);
    return { action: "allow", state: next };
  }

  // Denial: build the summary from the OLD (pre-reset) baseline, then reset
  // immediately — baselineTime/fileHashes/counts all advance together in the
  // same write, mirroring pear-runtime.ts's immediate (never-deferred) reset.
  const currentHashes = safeFileHashes(cwd);
  const files = filesSincePersistedBaseline(state.fileHashes, currentHashes);
  const summary = buildSummary(toolLabel(event), delta(state, now), files);
  const next = { ...freshState(currentHashes, now), awaitingSteering: true };
  saveState(cwd, next);
  return { action: "deny", summary, block: blockMessage(summary), state: next };
}
