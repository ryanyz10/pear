import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadState, reserve, saveState } from "../adapters/shared/hook-checkpoint.ts";
import { STEERING_CONTRACT } from "../adapters/shared/conversational.ts";

const ROOT = process.cwd();
const HOOKS = join(ROOT, "adapters", "cursor", "hooks");

type HookResult = { status: number | null; output: Record<string, unknown> };

function runHook(name: string, input: string | Record<string, unknown>, cwd: string): HookResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(HOOKS, name)],
    {
      cwd: ROOT,
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, HOME: cwd },
    },
  );
  return {
    status: result.status,
    output: JSON.parse(result.stdout || "{}") as Record<string, unknown>,
  };
}

function withTemp<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), "pear-cursor-hooks-"));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Writes `<cwd>/.pear/config.json` — used as both project and (via HOME) global config in these tests. */
function setConfig(cwd: string, patch: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pear"), { recursive: true });
  writeFileSync(join(cwd, ".pear", "config.json"), JSON.stringify(patch));
}

describe("Cursor hooks (agent-driver)", () => {
  it("allows five mutations, then denies with the steering contract", () => {
    withTemp((cwd) => {
      setConfig(cwd, { mode: "agent-driver", maxChangesPerCheckpoint: 5 });
      for (let i = 0; i < 5; i++) {
        const result = runHook(
          "pre-tool-use.ts",
          {
            cwd,
            tool_name: "Write",
            tool_use_id: `call-${i}`,
            tool_input: { file_path: `/tmp/${i}.txt` },
          },
          cwd,
        );
        assert.equal(result.status, 0);
        assert.deepEqual(result.output, {});
      }

      const denied = runHook(
        "pre-tool-use.ts",
        {
          cwd,
          tool_name: "Write",
          tool_use_id: "call-5",
          tool_input: { file_path: "/tmp/5.txt" },
        },
        cwd,
      );
      assert.equal(denied.status, 0);
      assert.equal(denied.output.permission, "deny");
      assert.ok(String(denied.output.agent_message).includes(STEERING_CONTRACT));
      assert.equal(denied.output.failClosed, false); // deny is soft/recoverable, not a hard fail-closed
    });
  });

  it("settles success and failure without exposing findings to the model", () => {
    withTemp((cwd) => {
      setConfig(cwd, { mode: "agent-driver", maxChangesPerCheckpoint: 5 });
      for (let i = 0; i < 2; i++) {
        runHook(
          "pre-tool-use.ts",
          { cwd, tool_name: "Write", tool_use_id: `call-${i}`, tool_input: {} },
          cwd,
        );
      }

      const success = runHook(
        "post-tool-use.ts",
        { cwd, tool_name: "Write", tool_use_id: "call-0", hook_event_name: "postToolUse" },
        cwd,
      );
      assert.deepEqual(success.output, {});
      assert.equal(loadState(cwd).confirmed, 1);

      const failure = runHook(
        "post-tool-use.ts",
        {
          cwd,
          tool_name: "Write",
          tool_use_id: "call-1",
          is_error: true,
        },
        cwd,
      );
      assert.deepEqual(failure.output, {});
      assert.equal(loadState(cwd).confirmed, 1);
      assert.equal(loadState(cwd).pending, 0);
    });
  });

  it("fails open on malformed stdin", () => {
    withTemp((cwd) => {
      setConfig(cwd, { mode: "agent-driver" });
      const result = runHook("pre-tool-use.ts", "{not-json", cwd);
      assert.equal(result.status, 0);
      assert.deepEqual(result.output, {});
    });
  });

  it("stop sweeps stale reservations", () => {
    withTemp((cwd) => {
      let state = loadState(cwd);
      state = reserve(state, "stale");
      saveState(cwd, state);
      assert.equal(loadState(cwd).pending, 1);

      const result = runHook("stop.ts", { cwd }, cwd);
      assert.equal(result.status, 0);
      assert.deepEqual(result.output, {});
      assert.equal(loadState(cwd).pending, 0);
      assert.deepEqual(loadState(cwd).reservations, []);
    });
  });
});

describe("Cursor hooks (off / human-driver no-ops)", () => {
  it("off mode never blocks, regardless of call count", () => {
    withTemp((cwd) => {
      setConfig(cwd, { mode: "off" });
      for (let i = 0; i < 10; i++) {
        const result = runHook(
          "pre-tool-use.ts",
          { cwd, tool_name: "Write", tool_use_id: `call-${i}`, tool_input: {} },
          cwd,
        );
        assert.equal(result.status, 0);
        assert.deepEqual(result.output, {});
      }
    });
  });

  it("human-driver mode never blocks a mutating tool call", () => {
    withTemp((cwd) => {
      setConfig(cwd, { mode: "human-driver" });
      const result = runHook(
        "pre-tool-use.ts",
        { cwd, tool_name: "Write", tool_use_id: "call-0", tool_input: {} },
        cwd,
      );
      assert.equal(result.status, 0);
      assert.deepEqual(result.output, {});
    });
  });

  it("no config at all defaults to off and never blocks", () => {
    withTemp((cwd) => {
      const result = runHook(
        "pre-tool-use.ts",
        { cwd, tool_name: "Write", tool_use_id: "call-0", tool_input: {} },
        cwd,
      );
      assert.equal(result.status, 0);
      assert.deepEqual(result.output, {});
    });
  });
});
