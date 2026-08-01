import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSummary } from "../../core/checkpoint.ts";
import { DEFAULTS, overBudget, type BudgetCfg } from "../../core/config.ts";
import { changedFiles, changedLines, gitOk } from "../../core/git.ts";
import { blockMessage } from "./conversational.ts";
import { ensurePearDir } from "./daemon.ts";

export type PersistedCheckpoint = {
  baselineLines: number;
  confirmed: number;
  pending: number;
  rebasePending: boolean;
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

function defaultState(cwd: string): PersistedCheckpoint {
  const isGit = gitOk(cwd);
  let baseline = 0;
  if (isGit) {
    try {
      baseline = changedLines(cwd);
    } catch {
      baseline = 0;
    }
  }
  return {
    baselineLines: baseline,
    confirmed: 0,
    pending: 0,
    rebasePending: false,
    reservations: [],
    awaitingSteering: false,
  };
}

export function loadState(cwd: string): PersistedCheckpoint {
  ensurePearDir(cwd);
  try {
    const raw = JSON.parse(readFileSync(statePath(cwd), "utf8")) as PersistedCheckpoint;
    if (typeof raw.baselineLines !== "number") return defaultState(cwd);
    return {
      baselineLines: raw.baselineLines,
      confirmed: raw.confirmed ?? 0,
      pending: raw.pending ?? 0,
      rebasePending: raw.rebasePending ?? false,
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

function safeLines(cwd: string): number | null {
  if (!gitOk(cwd)) return null;
  try {
    return changedLines(cwd);
  } catch {
    return null;
  }
}

function safeFiles(cwd: string): string[] {
  if (!gitOk(cwd)) return [];
  try {
    return changedFiles(cwd);
  } catch {
    return [];
  }
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

function checkBudget(state: PersistedCheckpoint, lines: number, cfg: BudgetCfg): boolean {
  return overBudget(
    {
      lines: state.rebasePending ? state.baselineLines : lines,
      mutations: state.confirmed + state.pending,
    },
    { lines: state.baselineLines, mutations: 0 },
    cfg,
  );
}

function delta(state: PersistedCheckpoint, lines: number) {
  return {
    lines: state.rebasePending ? 0 : lines - state.baselineLines,
    mutations: state.confirmed + state.pending,
  };
}

function resetAfterCheckpoint(
  state: PersistedCheckpoint,
  lines: number | null,
): PersistedCheckpoint {
  return {
    baselineLines: lines ?? state.baselineLines,
    confirmed: 0,
    pending: 0,
    rebasePending: lines === null,
    reservations: [],
    awaitingSteering: false,
  };
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

export function finishRebaseIfNeeded(cwd: string, state: PersistedCheckpoint): PersistedCheckpoint {
  if (!state.rebasePending) return state;
  const lines = safeLines(cwd);
  if (lines === null) return { ...state, rebasePending: false };
  return { ...state, baselineLines: lines, rebasePending: false };
}

export function gateTool(
  cwd: string,
  event: GateInput,
  cfg: BudgetCfg = { pauseLines: DEFAULTS.pauseLines, pauseEdits: DEFAULTS.pauseEdits },
): GateResult {
  let state = loadState(cwd);
  const isGit = gitOk(cwd);

  if (state.awaitingSteering) {
    const lines = isGit ? safeLines(cwd) : 0;
    state = resetAfterCheckpoint(
      state,
      isGit ? (state.pending > 0 ? null : lines) : 0,
    );
    saveState(cwd, state);
  }

  const lines = isGit ? (safeLines(cwd) ?? state.baselineLines) : 0;

  if (!checkBudget(state, lines, cfg)) {
    const next = reserve(state, event.callId);
    saveState(cwd, next);
    return { action: "allow", state: next };
  }

  const summary = buildSummary(toolLabel(event), delta(state, lines), safeFiles(cwd));
  const next = { ...state, awaitingSteering: true };
  saveState(cwd, next);
  return { action: "deny", summary, block: blockMessage(summary), state: next };
}
