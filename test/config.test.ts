import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ConfigWriteError,
  DEFAULTS,
  MAX_CHANGES,
  MIN_CHANGES,
  configPath,
  gateClosed,
  isValidMaxChanges,
  loadConfig,
  nodeFs,
  saveConfig,
  type ConfigFs,
} from "../core/config.ts";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "pear-cfg-"));
}

function writeConfig(dir: string, contents: string): void {
  mkdirSync(join(dir, ".pear"), { recursive: true });
  writeFileSync(configPath(dir), contents);
}

describe("gateClosed", () => {
  it("allows exactly max calls and blocks the next", () => {
    // max=5 => calls 1..5 admitted (counts 0..4 open), 6th blocked (count 5).
    assert.equal(gateClosed(0, 5), false);
    assert.equal(gateClosed(4, 5), false);
    assert.equal(gateClosed(5, 5), true);
    assert.equal(gateClosed(6, 5), true);
  });

  it("max=1 admits one call and blocks the second", () => {
    assert.equal(gateClosed(0, 1), false);
    assert.equal(gateClosed(1, 1), true);
  });
});

describe("isValidMaxChanges", () => {
  const bad = [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_CHANGES + 1, "5", null, undefined, {}];
  for (const v of bad) {
    it(`rejects ${JSON.stringify(v) ?? String(v)}`, () => {
      assert.equal(isValidMaxChanges(v), false);
    });
  }
  for (const v of [MIN_CHANGES, 5, MAX_CHANGES]) {
    it(`accepts ${v}`, () => {
      assert.equal(isValidMaxChanges(v), true);
    });
  }
});

describe("loadConfig", () => {
  it("returns defaults when the file is missing", () => {
    const dir = tempProject();
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.config, { ...DEFAULTS });
    assert.equal(loaded.missing, true);
    assert.equal(loaded.malformed, false);
  });

  it("reads a valid config", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ mode: "agent-driver", maxChangesPerCheckpoint: 3 }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.mode, "agent-driver");
    assert.equal(loaded.config.maxChangesPerCheckpoint, 3);
    assert.equal(loaded.legacyMode, undefined);
  });

  it("drops an out-of-range value but keeps the rest of the file", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ mode: "agent-driver", maxChangesPerCheckpoint: 0 }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.mode, "agent-driver");
    assert.equal(loaded.config.maxChangesPerCheckpoint, DEFAULTS.maxChangesPerCheckpoint);
  });

  it("surfaces a legacy human-driver mode instead of silently coercing", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ mode: "human-driver", reviewModel: "x/y" }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.legacyMode, "human-driver");
    assert.equal(loaded.config.mode, "off");
    // and the raw object still carries the unknown field
    assert.equal(loaded.raw.reviewModel, "x/y");
  });

  it("flags malformed JSON without throwing", () => {
    const dir = tempProject();
    writeConfig(dir, "{ this is not json");
    const loaded = loadConfig(dir);
    assert.equal(loaded.malformed, true);
    assert.deepEqual(loaded.config, { ...DEFAULTS });
  });

  it("treats a non-object JSON document as malformed", () => {
    const dir = tempProject();
    writeConfig(dir, "[1,2,3]");
    assert.equal(loadConfig(dir).malformed, true);
  });
});

describe("saveConfig", () => {
  it("round-trips and preserves unknown/legacy fields", () => {
    const dir = tempProject();
    writeConfig(
      dir,
      JSON.stringify({ mode: "human-driver", reviewModel: "a/b", futureSetting: { deep: true } }),
    );

    saveConfig(dir, { maxChangesPerCheckpoint: 7 });

    const onDisk = JSON.parse(readFileSync(configPath(dir), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.maxChangesPerCheckpoint, 7);
    // untouched:
    assert.equal(onDisk.mode, "human-driver");
    assert.equal(onDisk.reviewModel, "a/b");
    assert.deepEqual(onDisk.futureSetting, { deep: true });
  });

  it("creates .pear when missing", () => {
    const dir = tempProject();
    saveConfig(dir, { mode: "agent-driver" });
    assert.equal(loadConfig(dir).config.mode, "agent-driver");
  });

  it("refuses to persist an invalid value", () => {
    const dir = tempProject();
    assert.throws(() => saveConfig(dir, { maxChangesPerCheckpoint: 0 }), ConfigWriteError);
    assert.throws(
      () => saveConfig(dir, { mode: "human-driver" as unknown as "off" }),
      ConfigWriteError,
    );
  });

  it("backs up an unparseable file before replacing it", () => {
    const dir = tempProject();
    writeConfig(dir, "{ broken");
    saveConfig(dir, { mode: "agent-driver" }, nodeFs, () => 1234);

    const backup = readFileSync(join(dir, ".pear", "config.json.corrupt-1234"), "utf8");
    assert.equal(backup, "{ broken");
    assert.equal(loadConfig(dir).config.mode, "agent-driver");
  });

  it("leaves no temp file behind when the rename fails", () => {
    const dir = tempProject();
    const written: string[] = [];
    const failing: ConfigFs = {
      ...nodeFs,
      writeFileSync: (p, d) => {
        written.push(p);
        nodeFs.writeFileSync(p, d);
      },
      renameSync: () => {
        throw new Error("EXDEV: simulated");
      },
    };

    assert.throws(() => saveConfig(dir, { mode: "agent-driver" }, failing), ConfigWriteError);

    const leftovers = readdirSync(join(dir, ".pear")).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "temp file should be cleaned up");
    assert.equal(written.length, 1);
  });

  it("reports a write failure rather than silently succeeding", () => {
    const dir = tempProject();
    const failing: ConfigFs = {
      ...nodeFs,
      writeFileSync: () => {
        throw new Error("EACCES: simulated");
      },
    };
    assert.throws(() => saveConfig(dir, { mode: "agent-driver" }, failing), (e: unknown) => {
      assert.ok(e instanceof ConfigWriteError);
      assert.match(String((e as ConfigWriteError).cause), /EACCES/);
      return true;
    });
  });

  it("refuses to clobber an unparseable file it cannot back up", () => {
    const dir = tempProject();
    writeConfig(dir, "{ broken");
    const failing: ConfigFs = {
      ...nodeFs,
      copyFileSync: () => {
        throw new Error("EACCES: simulated");
      },
    };
    assert.throws(() => saveConfig(dir, { mode: "agent-driver" }, failing), ConfigWriteError);
    // original bytes intact
    assert.equal(readFileSync(configPath(dir), "utf8"), "{ broken");
  });

  it("uses a unique temp filename per write", () => {
    const dir = tempProject();
    const seen = new Set<string>();
    const spy: ConfigFs = {
      ...nodeFs,
      writeFileSync: (p, d) => {
        seen.add(p);
        nodeFs.writeFileSync(p, d);
      },
    };
    saveConfig(dir, { maxChangesPerCheckpoint: 2 }, spy);
    saveConfig(dir, { maxChangesPerCheckpoint: 3 }, spy);
    assert.equal(seen.size, 2, "temp paths must not collide");
  });
});
