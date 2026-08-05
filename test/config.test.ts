import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadUserConfig, saveUserConfig, resolveConfig } from "../core/config.ts";

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pear-config-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadUserConfig", () => {
  it("returns {} for a missing directory", () => {
    withDir((dir) => {
      assert.deepEqual(loadUserConfig(join(dir, "missing")), {});
    });
  });

  it("returns {} for malformed JSON", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(join(dir, ".pear", "config.json"), "{not json");
      assert.deepEqual(loadUserConfig(dir), {});
    });
  });

  it("drops an invalid reviewModel spec but keeps the rest of a valid file", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(
        join(dir, ".pear", "config.json"),
        JSON.stringify({ reviewModel: "bad", mode: "agent-driver", checkpointSeconds: 60 }),
      );
      assert.deepEqual(loadUserConfig(dir), { mode: "agent-driver", checkpointSeconds: 60 });
    });
  });

  it("drops an invalid mode but keeps the rest of a valid file", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(
        join(dir, ".pear", "config.json"),
        JSON.stringify({ mode: "not-a-mode", minLines: 20 }),
      );
      assert.deepEqual(loadUserConfig(dir), { minLines: 20 });
    });
  });

  it("drops a non-positive-integer cadence field but keeps the rest", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(
        join(dir, ".pear", "config.json"),
        JSON.stringify({ checkpointSeconds: -5, maxChangesPerCheckpoint: 2.5, minLines: 10 }),
      );
      assert.deepEqual(loadUserConfig(dir), { minLines: 10 });
    });
  });

  it("silently ignores unknown/legacy keys", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(
        join(dir, ".pear", "config.json"),
        JSON.stringify({ navModel: "openai/gpt-test", pauseLines: 150, minLines: 10 }),
      );
      assert.deepEqual(loadUserConfig(dir), { minLines: 10 });
    });
  });
});

describe("saveUserConfig", () => {
  it("round-trips through loadUserConfig, creating .pear/ if absent", () => {
    withDir((dir) => {
      assert.equal(existsSync(join(dir, ".pear")), false);
      saveUserConfig(dir, { mode: "agent-driver", checkpointSeconds: 120 });
      assert.equal(existsSync(join(dir, ".pear", "config.json")), true);
      assert.deepEqual(loadUserConfig(dir), { mode: "agent-driver", checkpointSeconds: 120 });
    });
  });

  it("drops an invalid model instead of persisting it", () => {
    withDir((dir) => {
      saveUserConfig(dir, { reviewModel: "bad", mode: "off" });
      assert.deepEqual(loadUserConfig(dir), { mode: "off" });
    });
  });

  it("writes pretty JSON with a trailing newline", () => {
    withDir((dir) => {
      saveUserConfig(dir, { reviewModel: "openai/gpt-test" });
      const raw = readFileSync(join(dir, ".pear", "config.json"), "utf8");
      assert.ok(raw.endsWith("\n"));
      assert.deepEqual(JSON.parse(raw), { reviewModel: "openai/gpt-test" });
    });
  });
});

describe("resolveConfig", () => {
  it("prefers project models over global when both are valid", () => {
    withDir((project) =>
      withDir((home) => {
        saveUserConfig(project, { reviewModel: "anthropic/claude-opus-4" });
        saveUserConfig(home, { reviewModel: "openai/gpt-test" });
        assert.equal(resolveConfig(project, home).reviewModel, "anthropic/claude-opus-4");
      }),
    );
  });

  it("falls back to the global model when project config has none", () => {
    withDir((project) =>
      withDir((home) => {
        saveUserConfig(home, { filterModel: "openai/gpt-test" });
        assert.equal(resolveConfig(project, home).filterModel, "openai/gpt-test");
      }),
    );
  });

  it("returns DEFAULTS when neither project nor global is set", () => {
    withDir((project) =>
      withDir((home) => {
        assert.deepEqual(resolveConfig(project, home), DEFAULTS);
      }),
    );
  });

  it("mode is project-only: a global mode never applies", () => {
    withDir((project) =>
      withDir((home) => {
        saveUserConfig(home, { mode: "agent-driver" });
        assert.equal(resolveConfig(project, home).mode, DEFAULTS.mode);
        saveUserConfig(project, { mode: "human-driver" });
        assert.equal(resolveConfig(project, home).mode, "human-driver");
      }),
    );
  });

  it("cadence fields are project-only: a global value never applies", () => {
    withDir((project) =>
      withDir((home) => {
        saveUserConfig(home, { checkpointSeconds: 900, minLines: 5 });
        const resolved = resolveConfig(project, home);
        assert.equal(resolved.checkpointSeconds, DEFAULTS.checkpointSeconds);
        assert.equal(resolved.minLines, DEFAULTS.minLines);
        saveUserConfig(project, { checkpointSeconds: 30 });
        assert.equal(resolveConfig(project, home).checkpointSeconds, 30);
      }),
    );
  });
});
