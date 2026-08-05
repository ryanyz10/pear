import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, saveUserConfig, resolveNavModelPreference } from "../core/config.ts";

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

  it("returns {} for an invalid navModel spec", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".pear"), { recursive: true });
      writeFileSync(join(dir, ".pear", "config.json"), JSON.stringify({ navModel: "bad" }));
      assert.deepEqual(loadUserConfig(dir), {});
    });
  });
});

describe("saveUserConfig", () => {
  it("round-trips through loadUserConfig, creating .pear/ if absent", () => {
    withDir((dir) => {
      assert.equal(existsSync(join(dir, ".pear")), false);
      saveUserConfig(dir, { navModel: "anthropic/claude-sonnet-4-5" });
      assert.equal(existsSync(join(dir, ".pear", "config.json")), true);
      assert.deepEqual(loadUserConfig(dir), { navModel: "anthropic/claude-sonnet-4-5" });
    });
  });

  it("throws the same invalid-model error as parseModel", () => {
    withDir((dir) => {
      assert.throws(() => saveUserConfig(dir, { navModel: "bad" }), /Invalid --model/);
      assert.equal(existsSync(join(dir, ".pear", "config.json")), false);
    });
  });

  it("writes pretty JSON with a trailing newline", () => {
    withDir((dir) => {
      saveUserConfig(dir, { navModel: "openai/gpt-test" });
      const raw = readFileSync(join(dir, ".pear", "config.json"), "utf8");
      assert.ok(raw.endsWith("\n"));
      assert.deepEqual(JSON.parse(raw), { navModel: "openai/gpt-test" });
    });
  });
});

describe("resolveNavModelPreference", () => {
  it("prefers project over global when both are valid", () => {
    withDir((project) =>
      withDir((home) => {
        saveUserConfig(project, { navModel: "anthropic/claude-opus-4" });
        saveUserConfig(home, { navModel: "openai/gpt-test" });
        assert.equal(resolveNavModelPreference(project, home), "anthropic/claude-opus-4");
      }),
    );
  });

  it("falls back to global when project config is invalid", () => {
    withDir((project) =>
      withDir((home) => {
        mkdirSync(join(project, ".pear"), { recursive: true });
        writeFileSync(join(project, ".pear", "config.json"), JSON.stringify({ navModel: "bad" }));
        saveUserConfig(home, { navModel: "openai/gpt-test" });
        assert.equal(resolveNavModelPreference(project, home), "openai/gpt-test");
      }),
    );
  });

  it("returns the global value when only global is set", () => {
    withDir((project) =>
      withDir((home) => {
        saveUserConfig(home, { navModel: "openai/gpt-test" });
        assert.equal(resolveNavModelPreference(project, home), "openai/gpt-test");
      }),
    );
  });

  it("returns undefined when neither is set", () => {
    withDir((project) =>
      withDir((home) => {
        assert.equal(resolveNavModelPreference(project, home), undefined);
      }),
    );
  });
});
