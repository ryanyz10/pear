// Deterministic, model-free harness exercising adapters/shared/pear-runtime.ts's
// mode-exclusive behavior end to end: agent-driver blocks at the cadence cap with
// the exact big-picture instruction, switching to off allows the same call, and a
// human-driver transition with an unresolvable model falls back to off with no
// review loop. Shared by smoke-pi.sh and smoke-omp.sh so both hosts' packaged
// extensions are proven against the same shared runtime without a live model or
// an interactive agent loop.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPearSession } from "../adapters/shared/pear-runtime.ts";
import type { PearConfig } from "../core/config.ts";

function fail(message: string): never {
  console.error(`smoke-pear-runtime: ${message}`);
  process.exit(1);
}

function assert(cond: unknown, message: string): void {
  if (!cond) fail(message);
}

const dir = mkdtempSync(join(tmpdir(), "pear-smoke-runtime-"));
try {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "smoke"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const notifies: Array<{ message: string; type?: string }> = [];
  const ui = {
    hasUI: true,
    notify: (message: string, type?: "info" | "warning" | "error") => {
      notifies.push({ message, type });
    },
    setStatus: () => {},
  };

  const cfg: Required<PearConfig> = {
    mode: "agent-driver",
    reviewModel: "openai/gpt-5.6-terra",
    filterModel: "openai/gpt-5.6-sol",
    minLines: 50,
    debounceSeconds: 10,
    intervalSeconds: 60,
    checkpointSeconds: 300,
    maxChangesPerCheckpoint: 2,
  };

  const session = createPearSession({
    cwd: dir,
    cfg,
    completions: { small: null, large: null },
    ui,
    onFindings: () => {},
    sendUserMessage: () => {},
    saveConfig: () => {},
  });

  await session.onToolCall({ toolCallId: "1", toolName: "write", input: { path: "a" } });
  session.onToolResult("1", false);
  await session.onToolCall({ toolCallId: "2", toolName: "write", input: { path: "b" } });
  session.onToolResult("2", false);
  const blocked = await session.onToolCall({ toolCallId: "3", toolName: "write", input: { path: "c" } });
  assert(blocked?.block === true, "agent-driver did not block at maxChangesPerCheckpoint");
  const summary = notifies.at(-1)?.message ?? "";
  assert(summary.includes("── checkpoint ──"), "checkpoint block missing the checkpoint banner");
  assert(
    summary.includes(
      "Before continuing: tell the human the big-picture goal of this batch and what you plan to do next, then continue.",
    ),
    "checkpoint block missing the big-picture instruction",
  );
  console.log("ok: agent-driver blocks at the cap with the big-picture instruction");

  session.setMode("off", { ...cfg, mode: "off" }, { small: null, large: null });
  const allowed = await session.onToolCall({ toolCallId: "4", toolName: "write", input: { path: "d" } });
  assert(allowed === undefined, "off mode blocked a call that should be allowed");
  console.log("ok: off mode allows the same call");

  session.setMode(
    "human-driver",
    { ...cfg, mode: "human-driver" },
    { small: null, large: null }, // unavailable model — resolution already failed upstream
  );
  assert(session.mode === "off", "human-driver with an unresolvable model should fall back to off");
  assert(session.scheduler === null, "human-driver fallback must not start a review loop");
  console.log("ok: an unavailable human-driver model falls back to off with no review loop");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
