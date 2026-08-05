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
  sweepTurnEnd,
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

const agentCfg = (over: { checkpointSeconds?: number; maxChangesPerCheckpoint?: number } = {}) => ({
  mode: "agent-driver" as const,
  checkpointSeconds: 99999,
  maxChangesPerCheckpoint: 2,
  ...over,
});

describe("gateTool allow/deny", () => {
  it("allows under budget and persists an incremented reservation", () => {
    withRepo("pear-hookcp-allow-", (dir) => {
      const cfg = agentCfg({ maxChangesPerCheckpoint: 2 });
      const r = gateTool(dir, { callId: "a", toolName: "write", input: { file_path: "x" } }, cfg);
      assert.equal(r.action, "allow");
      assert.equal(r.state.pending, 1);
      assert.deepEqual(r.state.reservations, ["a"]);
      assert.deepEqual(loadState(dir).reservations, ["a"]);
    });
  });

  it("denies at maxChangesPerCheckpoint, resets immediately, and the block text carries the steering contract", () => {
    withRepo("pear-hookcp-deny-", (dir) => {
      const cfg = agentCfg({ maxChangesPerCheckpoint: 2 });
      gateTool(dir, { callId: "a", toolName: "write", input: { file_path: "x" } }, cfg);
      gateTool(dir, { callId: "b", toolName: "write", input: { file_path: "y" } }, cfg);
      const beforeDeny = Date.now();
      const r = gateTool(dir, { callId: "c", toolName: "write", input: { file_path: "z" } }, cfg);
      assert.equal(r.action, "deny");
      assert.ok(r.block.includes(STEERING_CONTRACT));
      assert.equal(r.state.awaitingSteering, true);
      // Deny resets immediately: pending/confirmed/reservations all zeroed and
      // the baseline advances to the moment of denial, not deferred.
      assert.equal(r.state.pending, 0);
      assert.equal(r.state.confirmed, 0);
      assert.deepEqual(r.state.reservations, []);
      assert.ok(r.state.baselineTime >= beforeDeny);
      assert.deepEqual(loadState(dir), r.state);
    });
  });

  it("the next call after steering re-anchors the baseline to when work resumes", () => {
    withRepo("pear-hookcp-reanchor-", (dir) => {
      const cfg = agentCfg({ maxChangesPerCheckpoint: 1 });
      gateTool(dir, { callId: "a", toolName: "write", input: { file_path: "x" } }, cfg); // allow, pending=1
      const denyResult = gateTool(dir, { callId: "b", toolName: "write", input: { file_path: "y" } }, cfg); // deny + reset
      assert.equal(denyResult.action, "deny");
      assert.equal(denyResult.state.pending, 0);
      const denyBaseline = denyResult.state.baselineTime;

      const r = gateTool(dir, { callId: "c", toolName: "write", input: { file_path: "z" } }, cfg);
      assert.equal(r.action, "allow");
      assert.equal(r.state.awaitingSteering, false);
      assert.ok(r.state.baselineTime >= denyBaseline);
      assert.deepEqual(r.state.reservations, ["c"]);
      assert.equal(r.state.pending, 1);
    });
  });

  it("two-denial-cycle: each denial's summary lists only the newly-touched file", () => {
    withRepo("pear-hookcp-provenance-", (dir) => {
      // a.ts is dirty before agent-driver ever looks at this repo.
      writeFileSync(join(dir, "a.ts"), "pre-existing\n");
      const cfg = agentCfg({ maxChangesPerCheckpoint: 1 });

      gateTool(dir, { callId: "0", toolName: "write", input: { file_path: "a.ts" } }, cfg); // allow, captures baseline incl. a.ts
      saveState(dir, settle(loadState(dir), "0", true));

      writeFileSync(join(dir, "b.ts"), "b\n");
      const deny1 = gateTool(dir, { callId: "1", toolName: "write", input: { file_path: "b.ts" } }, cfg);
      assert.equal(deny1.action, "deny");
      assert.ok(deny1.summary.includes("b.ts"), deny1.summary);
      assert.ok(!deny1.summary.includes("a.ts"), deny1.summary);

      const allow2 = gateTool(dir, { callId: "2", toolName: "write", input: { file_path: "b.ts" } }, cfg); // steering resume, re-anchors
      assert.equal(allow2.action, "allow");
      saveState(dir, settle(loadState(dir), "2", true));

      writeFileSync(join(dir, "c.ts"), "c\n");
      const deny2 = gateTool(dir, { callId: "3", toolName: "write", input: { file_path: "c.ts" } }, cfg);
      assert.equal(deny2.action, "deny");
      assert.ok(deny2.summary.includes("c.ts"), deny2.summary);
      assert.ok(!deny2.summary.includes("a.ts"), deny2.summary);
      assert.ok(!deny2.summary.includes("b.ts"), deny2.summary);
    });
  });
});

describe("gateTool mode short-circuiting", () => {
  it("off mode allows without reserving or rewriting state", () => {
    withRepo("pear-hookcp-modeoff-", (dir) => {
      saveState(dir, loadState(dir)); // persist a concrete baseline to compare against
      const before = loadState(dir);
      const r = gateTool(dir, { callId: "a", toolName: "write", input: {} }, {
        mode: "off",
        checkpointSeconds: 1,
        maxChangesPerCheckpoint: 1,
      });
      assert.equal(r.action, "allow");
      assert.deepEqual(r.state, before);
      assert.deepEqual(loadState(dir), before);
    });
  });

  it("human-driver mode allows without reserving or rewriting state", () => {
    withRepo("pear-hookcp-modehuman-", (dir) => {
      saveState(dir, loadState(dir));
      const before = loadState(dir);
      const r = gateTool(dir, { callId: "a", toolName: "write", input: {} }, {
        mode: "human-driver",
        checkpointSeconds: 1,
        maxChangesPerCheckpoint: 1,
      });
      assert.equal(r.action, "allow");
      assert.deepEqual(r.state, before);
      assert.deepEqual(loadState(dir), before);
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

describe("sweepTurnEnd", () => {
  it("clears stale reservations but leaves baseline/awaitingSteering untouched", () => {
    withRepo("pear-hookcp-sweep-", (dir) => {
      const state = reserve(reserve(loadState(dir), "a"), "b");
      const dirty = { ...state, awaitingSteering: true };
      const swept = sweepTurnEnd(dirty);
      assert.equal(swept.pending, 0);
      assert.deepEqual(swept.reservations, []);
      assert.equal(swept.baselineTime, dirty.baselineTime);
      assert.deepEqual(swept.fileHashes, dirty.fileHashes);
      assert.equal(swept.awaitingSteering, true);
    });
  });

  it("is a no-op when nothing is pending", () => {
    withRepo("pear-hookcp-sweepnoop-", (dir) => {
      const state = loadState(dir);
      assert.deepEqual(sweepTurnEnd(state), state);
    });
  });
});

describe("loadState defaults", () => {
  it("returns zeroed defaults when checkpoint.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-hookcp-missing-"));
    try {
      const s = loadState(dir);
      assert.equal(s.confirmed, 0);
      assert.equal(s.pending, 0);
      assert.deepEqual(s.reservations, []);
      assert.equal(s.awaitingSteering, false);
      assert.equal(typeof s.baselineTime, "number");
      assert.deepEqual(s.fileHashes, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns fresh defaults when checkpoint.json is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-hookcp-malformed-"));
    try {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(join(dir, ".pear", "checkpoint.json"), "{not json");
      const s = loadState(dir);
      assert.equal(s.pending, 0);
      assert.deepEqual(s.fileHashes, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns fresh defaults for legacy line-based state (no baselineTime/fileHashes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-hookcp-legacy-"));
    try {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(
        join(dir, ".pear", "checkpoint.json"),
        JSON.stringify({ baselineLines: 40, confirmed: 3, pending: 1, rebasePending: false }),
      );
      const s = loadState(dir);
      assert.equal(s.confirmed, 0);
      assert.equal(s.pending, 0);
      assert.deepEqual(s.fileHashes, {});
      assert.equal(typeof s.baselineTime, "number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("non-git pacing", () => {
  it("paces on change count alone outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-hookcp-nongit-"));
    try {
      const cfg = agentCfg({ maxChangesPerCheckpoint: 1 });
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
