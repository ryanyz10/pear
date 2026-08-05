/**
 * Background navigator daemon for hook-based hosts (Claude Code, Cursor).
 *
 * Usage:
 *   node --experimental-strip-types adapters/shared/daemon.ts --cwd <dir>
 *   node --experimental-strip-types adapters/shared/daemon.ts --stop --cwd <dir>
 *
 * Only runs its poll/review loop in human-driver mode (per `.pear/config.json`);
 * every other mode is a no-op. Polls git state → core scheduler → review →
 * appends findings to .pear/findings.pending.
 * Pidfile: .pear/daemon.pid
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveConfig } from "../../core/config.ts";
import { changedLines, diffText, gitOk, quickStateHash } from "../../core/git.ts";
import { runReview, type Complete } from "../../core/llm.ts";
import { createScheduler } from "../../core/navigate.ts";
import { formatFindings } from "../../core/review.ts";

export type DaemonOpts = {
  cwd: string;
  /** Review transport factory: model spec -> completion fn. Default: `claude -p`. */
  complete?: (model: string) => Complete;
  pollMs?: number;
};

const PEAR_DIR = ".pear";
const PIDFILE = "daemon.pid";
const FINDINGS = "findings.pending";
const FINDINGS_LOG = "findings.log";

export function pearDir(cwd: string): string {
  return join(cwd, PEAR_DIR);
}

export function pidPath(cwd: string): string {
  return join(pearDir(cwd), PIDFILE);
}

export function findingsPendingPath(cwd: string): string {
  return join(pearDir(cwd), FINDINGS);
}

export function findingsLogPath(cwd: string): string {
  return join(pearDir(cwd), FINDINGS_LOG);
}

export function ensurePearDir(cwd: string): void {
  mkdirSync(pearDir(cwd), { recursive: true });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPid(cwd: string): number | null {
  try {
    const n = Number(readFileSync(pidPath(cwd), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writePid(cwd: string, pid: number): void {
  ensurePearDir(cwd);
  writeFileSync(pidPath(cwd), String(pid));
}

export function stopDaemon(cwd: string): boolean {
  const pid = readPid(cwd);
  try {
    unlinkSync(pidPath(cwd));
  } catch {
    /* */
  }
  if (pid == null) return false;
  if (!isPidAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Append formatted findings for host hooks to drain. */
export function appendFindings(cwd: string, text: string): void {
  ensurePearDir(cwd);
  appendFileSync(findingsPendingPath(cwd), text.endsWith("\n") ? text : text + "\n");
  appendFileSync(findingsLogPath(cwd), text.endsWith("\n") ? text : text + "\n");
}

/** Read and truncate pending findings (hook drain). */
export function drainFindings(cwd: string): string {
  const p = findingsPendingPath(cwd);
  try {
    const text = readFileSync(p, "utf8");
    writeFileSync(p, "");
    return text;
  } catch {
    return "";
  }
}

function defaultComplete(model: string): Complete {
  return (system, user) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "claude",
        ["-p", "--model", model, "--system-prompt", system],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += String(d)));
      child.stderr?.on("data", (d) => (err += String(d)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(err.trim() || `claude exited ${code}`));
      });
      child.stdin?.write(user);
      child.stdin?.end();
    });
}

export function runDaemonLoop(opts: DaemonOpts): { stop: () => void } {
  const cwd = opts.cwd;
  const cfg = resolveConfig(cwd, homedir());
  if (cfg.mode !== "human-driver") {
    return { stop: () => {} };
  }
  if (!gitOk(cwd)) {
    throw new Error("pear daemon requires a git working tree");
  }
  ensurePearDir(cwd);
  const existing = readPid(cwd);
  if (existing != null && isPidAlive(existing) && existing !== process.pid) {
    throw new Error(`pear daemon already running (pid ${existing})`);
  }
  writePid(cwd, process.pid);

  const completeFactory = opts.complete ?? defaultComplete;
  const completeSmall = completeFactory(cfg.reviewModel);
  const completeLarge = completeFactory(cfg.filterModel);

  const scheduler = createScheduler(
    { minLines: cfg.minLines, intervalSeconds: cfg.intervalSeconds, debounceSeconds: cfg.debounceSeconds },
    {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
      getChangedLines: () => changedLines(cwd),
      getDiffText: () => diffText(cwd),
      runReview: async (diff) => {
        try {
          const { kept, filtered } = await runReview(completeSmall, completeLarge, diff);
          appendFindings(cwd, formatFindings(kept, filtered));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      onOutput: (text) => appendFindings(cwd, text),
    },
  );

  const pollMs = opts.pollMs ?? 2000;
  const timer = setInterval(() => {
    try {
      scheduler.notify(quickStateHash(cwd));
    } catch {
      /* transient */
    }
  }, pollMs);

  const stop = () => {
    clearInterval(timer);
    scheduler.stop();
    try {
      if (readPid(cwd) === process.pid) unlinkSync(pidPath(cwd));
    } catch {
      /* */
    }
  };

  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });

  return { stop };
}

/** Spawn daemon detached; returns child or null if already running. */
export function spawnDaemon(opts: DaemonOpts): ChildProcess | null {
  const cwd = opts.cwd;
  const existing = readPid(cwd);
  if (existing != null && isPidAlive(existing)) return null;
  ensurePearDir(cwd);
  const args = [
    "--experimental-strip-types",
    new URL(import.meta.url).pathname,
    "--cwd",
    cwd,
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd,
  });
  child.unref();
  return child;
}

// CLI entry when run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("daemon.ts") || process.argv[1].endsWith("daemon.js"));

if (isMain) {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  let stop = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") cwd = args[++i]!;
    else if (args[i] === "--stop") stop = true;
  }
  if (stop) {
    process.exit(stopDaemon(cwd) ? 0 : 1);
  }
  runDaemonLoop({ cwd });
  // Keep process alive
}
