import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  gateTool,
  loadState,
  saveState,
  reserve,
  settle,
  toolLabel,
} from "../adapters/shared/hook-checkpoint.ts";
import { STEERING_CONTRACT } from "../core/checkpoint.ts";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(" "));
  return r.stdout;
}

function withRepo<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, ".gitignore"), ".pear/\n");
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "pear@test"]);
  git(dir, ["config", "user.name", "pear"]);
  git(dir, ["add", ".gitignore"]);
  git(dir, ["commit", "-m", "init"]);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gateTool allow/deny", () => {
  it("allows under budget and persists an incremented reservation", () => {
    withRepo("pear-hookcp-allow-", (dir) => {
      const cfg = { pauseLines: 200, pauseEdits: 2 };
      const r = gateTool(dir, { callId: "a", toolName: "write", input: { file_path: "x" } }, cfg);
      assert.equal(r.action, "allow");
      assert.equal(r.state.pending, 1);
      assert.deepEqual(r.state.reservations, ["a"]);
      assert.deepEqual(loadState(dir).reservations, ["a"]);
    });
  });

  it("denies at pauseEdits, sets awaitingSteering, and the block text carries the steering contract", () => {
    withRepo("pear-hookcp-deny-", (dir) => {
      const cfg = { pauseLines: 200, pauseEdits: 2 };
      gateTool(dir, { callId: "a", toolName: "write", input: { file_path: "x" } }, cfg);
      gateTool(dir, { callId: "b", toolName: "write", input: { file_path: "y" } }, cfg);
      const r = gateTool(dir, { callId: "c", toolName: "write", input: { file_path: "z" } }, cfg);
      assert.equal(r.action, "deny");
      assert.ok(r.block.includes(STEERING_CONTRACT));
      assert.equal(r.state.awaitingSteering, true);
      assert.equal(loadState(dir).awaitingSteering, true);
      assert.equal(r.state.pending, 2); // deny never reserves
    });
  });

  it("a later call while awaitingSteering with pending>0 defers the baseline (rebasePending)", () => {
    withRepo("pear-hookcp-defer-", (dir) => {
      const cfg = { pauseLines: 200, pauseEdits: 1 };
      gateTool(dir, { callId: "a", toolName: "write", input: { file_path: "x" } }, cfg); // allow, pending=1
      gateTool(dir, { callId: "b", toolName: "write", input: { file_path: "y" } }, cfg); // deny, awaitingSteering=true, pending stays 1
      const r = gateTool(dir, { callId: "c", toolName: "write", input: { file_path: "z" } }, cfg);
      assert.equal(r.action, "allow");
      assert.equal(r.state.rebasePending, true);
      assert.equal(r.state.pending, 1);
      assert.equal(r.state.confirmed, 0);
      assert.deepEqual(r.state.reservations, ["c"]);
    });
  });

  it("a later call while awaitingSteering with pending==0 resets the baseline immediately", () => {
    withRepo("pear-hookcp-reset-", (dir) => {
      const cfg = { pauseLines: 200, pauseEdits: 1 };
      gateTool(dir, { callId: "a", toolName: "write", input: { file_path: "x" } }, cfg); // allow, pending=1
      gateTool(dir, { callId: "b", toolName: "write", input: { file_path: "y" } }, cfg); // deny, awaitingSteering=true
      let state = loadState(dir);
      state = settle(state, "a", true); // pending=0, confirmed=1
      saveState(dir, state);
      const r = gateTool(dir, { callId: "c", toolName: "write", input: { file_path: "z" } }, cfg);
      assert.equal(r.action, "allow");
      assert.equal(r.state.rebasePending, false);
      assert.equal(r.state.pending, 1);
      assert.equal(r.state.confirmed, 0); // reset wiped the earlier confirmed=1
      assert.deepEqual(r.state.reservations, ["c"]);
    });
  });
});

describe("settle", () => {
  it("ok=false decrements pending without incrementing confirmed — the PostToolUseFailure path", () => {
    withRepo("pear-hookcp-settlefail-", (dir) => {
      let state = reserve(loadState(dir), "id1");
      state = settle(state, "id1", false);
      assert.equal(state.pending, 0);
      assert.equal(state.confirmed, 0);
      assert.ok(!state.reservations.includes("id1"));
    });
  });

  it("ok=true decrements pending and increments confirmed — the PostToolUse path", () => {
    withRepo("pear-hookcp-settleok-", (dir) => {
      let state = reserve(loadState(dir), "id1");
      state = settle(state, "id1", true);
      assert.equal(state.pending, 0);
      assert.equal(state.confirmed, 1);
    });
  });

  it("settling an unknown callId is a no-op", () => {
    withRepo("pear-hookcp-settlenoop-", (dir) => {
      const state = loadState(dir);
      const next = settle(state, "never-reserved", true);
      assert.deepEqual(next, state);
    });
  });
});

describe("loadState defaults", () => {
  it("returns zeroed defaults when checkpoint.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-hookcp-missing-"));
    try {
      assert.deepEqual(loadState(dir), {
        baselineLines: 0,
        confirmed: 0,
        pending: 0,
        rebasePending: false,
        reservations: [],
        awaitingSteering: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns defaults when checkpoint.json is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-hookcp-malformed-"));
    try {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(join(dir, ".pear", "checkpoint.json"), "{not json");
      const s = loadState(dir);
      assert.equal(s.pending, 0);
      assert.equal(s.baselineLines, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("non-git pacing", () => {
  it("paces on mutation count alone with lines fixed at 0 outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-hookcp-nongit-"));
    try {
      const cfg = { pauseLines: 200, pauseEdits: 1 };
      const r1 = gateTool(dir, { callId: "a", toolName: "bash", input: { command: "ls" } }, cfg);
      const r2 = gateTool(dir, { callId: "b", toolName: "bash", input: { command: "ls" } }, cfg);
      assert.equal(r1.action, "allow");
      assert.equal(r2.action, "deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("toolLabel", () => {
  it("formats bash commands truncated to 80 chars", () => {
    const label = toolLabel({ callId: "x", toolName: "bash", input: { command: "a".repeat(100) } });
    assert.equal(label, `bash ${"a".repeat(80)}`);
  });

  it("formats file-path tools from file_path/filePath/path", () => {
    assert.equal(
      toolLabel({ callId: "x", toolName: "write", input: { file_path: "/tmp/a.ts" } }),
      "write /tmp/a.ts",
    );
    assert.equal(toolLabel({ callId: "x", toolName: "edit", input: {} }), "edit");
  });
});
