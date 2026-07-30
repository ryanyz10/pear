import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { overBudget, type BudgetCfg, type BudgetStats } from "./config.ts";
import { changedFiles, changedLines } from "./git.ts";

export { overBudget };
export type { BudgetStats };

export type ToolsCtx = {
  cwd: string;
  isGit: boolean;
  budget: BudgetCfg;
  /** Prompt human at a checkpoint. Return "" to continue (execute), or steering text. */
  askCheckpoint: (summary: string) => Promise<string>;
};

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function rel(cwd: string, p: string): string {
  const r = relative(cwd, p);
  return r.startsWith("..") ? p : r || ".";
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function createTools(ctx: ToolsCtx): {
  tools: AgentTool[];
  getBaseline: () => BudgetStats;
  resetBaseline: () => void;
  bumpMutation: () => void;
  currentStats: () => BudgetStats;
  maybeFinalCheckpoint: () => Promise<void>;
} {
  let baseline: BudgetStats = { lines: 0, mutations: 0 };
  let mutations = 0;

  const currentStats = (): BudgetStats => ({
    lines: ctx.isGit ? changedLines(ctx.cwd) : 0,
    mutations,
  });

  const resetBaseline = () => {
    baseline = currentStats();
  };

  const bumpMutation = () => {
    mutations++;
  };

  async function gate(label: string): Promise<"go" | string> {
    const cur = currentStats();
    // Non-git: lines stay 0; mutation counter alone paces.
    if (!overBudget(cur, baseline, ctx.budget)) return "go";
    const files = ctx.isGit ? changedFiles(ctx.cwd) : [];
    const dLines = cur.lines - baseline.lines;
    const dMut = cur.mutations - baseline.mutations;
    const summary =
      `── checkpoint ──\n` +
      `+${dLines} lines / ${dMut} mutations since last look` +
      (files.length ? `\nfiles: ${files.slice(0, 12).join(", ")}${files.length > 12 ? "…" : ""}` : "") +
      `\nabout to: ${label}\n` +
      `Enter = continue, or type steering: `;
    const steer = (await ctx.askCheckpoint(summary)).trim();
    resetBaseline();
    if (!steer) return "go";
    return `NOT EXECUTED — human steering: ${steer}`;
  }

  const read: AgentTool = {
    name: "read",
    label: "Read",
    description: "Read a file's contents",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params) => {
      const { path } = params as { path: string };
      const p = abs(ctx.cwd, path);
      if (!existsSync(p)) throw new Error(`File not found: ${path}`);
      return textResult(readFileSync(p, "utf8"));
    },
  };

  const write: AgentTool = {
    name: "write",
    label: "Write",
    description: "Write contents to a file (creates parents)",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    execute: async (_id, params) => {
      const { path, content } = params as { path: string; content: string };
      const decision = await gate(`write ${path}`);
      if (decision !== "go") return textResult(decision);
      const p = abs(ctx.cwd, path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      bumpMutation();
      return textResult(`wrote ${rel(ctx.cwd, p)} (${content.length} bytes)`);
    },
  };

  const edit: AgentTool = {
    name: "edit",
    label: "Edit",
    description: "Replace an exact string occurrence in a file",
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.String(),
      newText: Type.String(),
    }),
    execute: async (_id, params) => {
      const { path, oldText, newText } = params as {
        path: string;
        oldText: string;
        newText: string;
      };
      const decision = await gate(`edit ${path}`);
      if (decision !== "go") return textResult(decision);
      const p = abs(ctx.cwd, path);
      if (!existsSync(p)) throw new Error(`File not found: ${path}`);
      const before = readFileSync(p, "utf8");
      const i = before.indexOf(oldText);
      if (i < 0) throw new Error(`oldText not found in ${path}`);
      if (before.indexOf(oldText, i + 1) >= 0) {
        throw new Error(`oldText not unique in ${path}`);
      }
      writeFileSync(p, before.slice(0, i) + newText + before.slice(i + oldText.length));
      bumpMutation();
      return textResult(`edited ${rel(ctx.cwd, p)}`);
    },
  };

  const bash: AgentTool = {
    name: "bash",
    label: "Bash",
    description: "Run a shell command in the project directory",
    parameters: Type.Object({
      command: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params, signal) => {
      const { command, timeoutMs } = params as { command: string; timeoutMs?: number };
      const decision = await gate(`bash ${command.slice(0, 80)}`);
      if (decision !== "go") return textResult(decision);
      const out = await runBash(ctx.cwd, command, timeoutMs ?? 60_000, signal);
      bumpMutation();
      return textResult(out);
    },
  };

  async function maybeFinalCheckpoint() {
    if (!overBudget(currentStats(), baseline, ctx.budget)) return;
    const files = ctx.isGit ? changedFiles(ctx.cwd) : [];
    const cur = currentStats();
    const summary =
      `── checkpoint (end of turn) ──\n` +
      `+${cur.lines - baseline.lines} lines / ${cur.mutations - baseline.mutations} mutations` +
      (files.length ? `\nfiles: ${files.slice(0, 12).join(", ")}` : "") +
      `\nEnter = continue, or type steering: `;
    await ctx.askCheckpoint(summary);
    resetBaseline();
  }

  resetBaseline();
  return {
    tools: [read, write, edit, bash],
    getBaseline: () => baseline,
    resetBaseline,
    bumpMutation,
    currentStats,
    maybeFinalCheckpoint,
  };
}

function runBash(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveP, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bash timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      const body = (stdout + (stderr ? `\n${stderr}` : "")).slice(0, 100_000);
      resolveP(code === 0 ? body || "(no output)" : `exit ${code}\n${body}`);
    });
  });
}
