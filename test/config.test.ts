import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BLOCK_MULTIPLE,
  ConfigWriteError,
  DEFAULTS,
  LEGACY_BUDGET_KEY,
  LEGACY_CHANGE_POINTS,
  LEGACY_MODES,
  MODES,
  MAX_BUDGET,
  MIN_BUDGET,
  SOFT_FRACTION,
  CONFIG_KEYS,
  CONFIG_SPECS,
  configPath,
  formatConfigValue,
  isConfigKey,
  isMode,
  isValidBudget,
  loadConfig,
  loadTier,
  nodeFs,
  parseConfigEdit,
  parseConfigValue,
  saveConfig,
  summariseConfigValue,
  type ConfigFs,
} from "../core/config.ts";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "pear-cfg-"));
}

function writeConfig(dir: string, contents: string): void {
  mkdirSync(join(dir, ".pear"), { recursive: true });
  writeFileSync(configPath(dir), contents);
}

describe("loadTier", () => {
  const B = 200;

  it("is quiet below the soft fraction", () => {
    assert.equal(loadTier(0, B), "quiet");
    assert.equal(loadTier(99, B), "quiet");
  });

  it("nags softly from the soft fraction up to the budget", () => {
    assert.equal(loadTier(100, B), "soft");
    assert.equal(loadTier(199, B), "soft");
  });

  it("says a checkpoint is due at the budget", () => {
    assert.equal(loadTier(200, B), "due");
    assert.equal(loadTier(399, B), "due");
  });

  it("blocks at the block multiple", () => {
    assert.equal(loadTier(400, B), "blocked");
    assert.equal(loadTier(4000, B), "blocked");
  });

  it("derives its boundaries from the exported constants", () => {
    // Guards against the thresholds and the constants drifting apart.
    assert.equal(loadTier(B * SOFT_FRACTION, B), "soft");
    assert.equal(loadTier(B * SOFT_FRACTION - 1, B), "quiet");
    assert.equal(loadTier(B * BLOCK_MULTIPLE, B), "blocked");
    assert.equal(loadTier(B * BLOCK_MULTIPLE - 1, B), "due");
  });

  it("never blocks at zero load, whatever the budget", () => {
    // Admit-first depends on this: the first change in a window always runs.
    for (const budget of [MIN_BUDGET, 200, MAX_BUDGET]) {
      assert.notEqual(loadTier(0, budget), "blocked", `budget ${budget}`);
    }
  });
});

describe("loadTier: configured boundaries", () => {
  it("moves the soft line with softFraction", () => {
    assert.equal(loadTier(50, 200, 0.1, 2), "soft");
    assert.equal(loadTier(50, 200, 0.9, 2), "quiet");
  });

  it("moves the block line with blockMultiple", () => {
    assert.equal(loadTier(300, 200, 0.5, 1.5), "blocked");
    assert.equal(loadTier(300, 200, 0.5, 4), "due");
  });

  it("keeps due at the budget itself, whatever the fractions", () => {
    // "due" is the budget by definition; only the tiers around it move.
    for (const [soft, block] of [
      [0.1, 1.2],
      [0.9, 8],
    ] as const) {
      assert.equal(loadTier(199, 200, soft, block), soft <= 0.995 ? "soft" : "quiet");
      assert.equal(loadTier(200, 200, soft, block), "due");
    }
  });

  it("defaults to the exported constants", () => {
    assert.equal(loadTier(100, 200), loadTier(100, 200, SOFT_FRACTION, BLOCK_MULTIPLE));
    assert.equal(loadTier(400, 200), loadTier(400, 200, SOFT_FRACTION, BLOCK_MULTIPLE));
  });
});

describe("CONFIG_SPECS", () => {
  it("covers every key of the defaults, and only those", () => {
    // The table is what loadConfig and saveConfig both walk, so a key missing
    // from it is a key that silently never loads.
    assert.deepEqual([...CONFIG_KEYS].sort(), Object.keys(DEFAULTS).sort());
  });

  it("accepts its own defaults", () => {
    for (const key of CONFIG_KEYS) {
      assert.equal(CONFIG_SPECS[key].validate(DEFAULTS[key]), true, key);
    }
  });

  it("rejects values that would invert the tier ordering", () => {
    for (const bad of [0, 1, -0.5, 1.5, "0.5", NaN, Infinity]) {
      assert.equal(CONFIG_SPECS.softFraction.validate(bad), false, String(bad));
    }
    for (const bad of [1, 0.5, -2, "2", NaN]) {
      assert.equal(CONFIG_SPECS.blockMultiple.validate(bad), false, String(bad));
    }
  });

  it("takes any list of strings as the read-only commands", () => {
    // The list is the human's policy; pear only checks the shape.
    assert.equal(CONFIG_SPECS.allowedReadOnlyCommands.validate(["rm -rf"]), true);
    assert.equal(CONFIG_SPECS.allowedReadOnlyCommands.validate([]), true);
    assert.equal(CONFIG_SPECS.allowedReadOnlyCommands.validate(["ok", 2]), false);
    assert.equal(CONFIG_SPECS.allowedReadOnlyCommands.validate("ls"), false);
  });

  it("bounds the watcher timings away from zero", () => {
    assert.equal(CONFIG_SPECS.pollMs.validate(0), false);
    assert.equal(CONFIG_SPECS.pollMs.validate(2_000), true);
    assert.equal(CONFIG_SPECS.pollMs.validate(2_000.5), false);
    assert.equal(CONFIG_SPECS.maxPollFailures.validate(0), false);
    assert.equal(CONFIG_SPECS.maxPollFailures.validate(1), true);
  });
});

describe("parseConfigValue", () => {
  it("reads booleans the several ways a human writes them", () => {
    for (const yes of ["true", "on", "YES", "1"]) {
      assert.deepEqual(parseConfigValue("statusIcon", yes), { ok: true, value: true }, yes);
    }
    for (const no of ["false", "off", "No", "0"]) {
      assert.deepEqual(parseConfigValue("statusIcon", no), { ok: true, value: false }, no);
    }
    assert.deepEqual(parseConfigValue("statusIcon", "maybe"), { ok: false });
  });

  it("splits command lists on commas, not spaces", () => {
    // `git log` is one entry: splitting on whitespace would break every
    // subcommand in the default list.
    assert.deepEqual(parseConfigValue("allowedReadOnlyCommands", "git log, ls , cat"), {
      ok: true,
      value: ["git log", "ls", "cat"],
    });
    assert.deepEqual(parseConfigValue("allowedReadOnlyCommands", ""), { ok: true, value: [] });
  });

  it("refuses an empty number rather than reading it as zero", () => {
    // Number("") is 0, which would silently set a budget of nothing.
    assert.deepEqual(parseConfigValue("reviewBudget", "  "), { ok: false });
    assert.deepEqual(parseConfigValue("pollMs", ""), { ok: false });
  });

  it("applies the same bounds a write would", () => {
    assert.deepEqual(parseConfigValue("reviewBudget", "300"), { ok: true, value: 300 });
    assert.deepEqual(parseConfigValue("reviewBudget", "1"), { ok: false });
    assert.deepEqual(parseConfigValue("softFraction", "0.25"), { ok: true, value: 0.25 });
    assert.deepEqual(parseConfigValue("softFraction", "2"), { ok: false });
    assert.deepEqual(parseConfigValue("mode", "agent-driver"), {
      ok: true,
      value: "agent-driver",
    });
    assert.deepEqual(parseConfigValue("mode", "driver"), { ok: false });
  });

  it("round-trips through formatConfigValue", () => {
    for (const key of CONFIG_KEYS) {
      const shown = formatConfigValue(DEFAULTS[key]);
      assert.deepEqual(parseConfigValue(key, shown), { ok: true, value: DEFAULTS[key] }, key);
    }
  });
});

describe("parseConfigEdit", () => {
  const list = ["ls", "cat", "git log"];

  it("adds without disturbing what is already there", () => {
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "+rg", list), {
      ok: true,
      value: ["ls", "cat", "git log", "rg"],
    });
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "+rg, fd", list), {
      ok: true,
      value: ["ls", "cat", "git log", "rg", "fd"],
    });
  });

  it("removes only the named entry", () => {
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "-cat", list), {
      ok: true,
      value: ["ls", "git log"],
    });
    // Entries contain spaces, so removal splits on commas like everything else.
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "-git log", list), {
      ok: true,
      value: ["ls", "cat"],
    });
  });

  it("says nothing changed rather than writing a no-op", () => {
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "+cat", list), {
      ok: false,
      reason: "unchanged",
      entries: ["cat"],
    });
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "-rg", list), {
      ok: false,
      reason: "absent",
      entries: ["rg"],
    });
  });

  it("applies a partial add or remove and reports nothing when neither lands", () => {
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "+cat, rg", list), {
      ok: true,
      value: ["ls", "cat", "git log", "rg"],
    });
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "-cat, rg", list), {
      ok: true,
      value: ["ls", "git log"],
    });
  });

  it("puts any key back to its default", () => {
    for (const word of ["default", "defaults", "RESET"]) {
      assert.deepEqual(
        parseConfigEdit("allowedReadOnlyCommands", word, []),
        { ok: true, value: DEFAULTS.allowedReadOnlyCommands },
        word,
      );
    }
    assert.deepEqual(parseConfigEdit("reviewBudget", "reset", 900), {
      ok: true,
      value: DEFAULTS.reviewBudget,
    });
  });

  it("treats a plain value as the whole value, exactly as before", () => {
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "ls, cat", list), {
      ok: true,
      value: ["ls", "cat"],
    });
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "", list), {
      ok: true,
      value: [],
    });
    assert.deepEqual(parseConfigEdit("reviewBudget", "300", 200), { ok: true, value: 300 });
    assert.deepEqual(parseConfigEdit("reviewBudget", "nope", 200), {
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses +/- where they would read as a sign", () => {
    // "-200" on a number is a value, not a removal; refusing is the only way
    // the two readings cannot be confused.
    assert.deepEqual(parseConfigEdit("reviewBudget", "+300", 200), { ok: false, reason: "invalid" });
    assert.deepEqual(parseConfigEdit("reviewBudget", "-300", 200), { ok: false, reason: "invalid" });
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "+", list), {
      ok: false,
      reason: "invalid",
    });
  });

  it("starts from empty when the current value is not a list", () => {
    assert.deepEqual(parseConfigEdit("allowedReadOnlyCommands", "+ls", undefined), {
      ok: true,
      value: ["ls"],
    });
  });
});

describe("summariseConfigValue", () => {
  it("leaves a short value alone", () => {
    assert.equal(summariseConfigValue(["ls", "cat"]), "ls, cat");
    assert.equal(summariseConfigValue(true), "true");
  });

  it("elides a long list and names how many entries it has", () => {
    const shown = summariseConfigValue(DEFAULTS.allowedReadOnlyCommands, 40);
    assert.ok(shown.length <= 40, shown);
    assert.match(shown, /\u2026 \(\d+\)$/);
  });

  it("elides a long scalar without a count", () => {
    const shown = summariseConfigValue("x".repeat(80), 20);
    assert.equal(shown, `${"x".repeat(19)}\u2026`);
  });
});

describe("isConfigKey", () => {
  it("accepts every key and nothing else", () => {
    for (const key of CONFIG_KEYS) assert.equal(isConfigKey(key), true, key);
    for (const no of ["budget", "", "toString", "constructor", 3, null]) {
      assert.equal(isConfigKey(no), false, String(no));
    }
  });
});

describe("isValidBudget", () => {
  const bad = [
    0,
    -3,
    2.5,
    MIN_BUDGET - 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_BUDGET + 1,
    "200",
    null,
    undefined,
    {},
  ];
  for (const v of bad) {
    it(`rejects ${JSON.stringify(v) ?? String(v)}`, () => {
      assert.equal(isValidBudget(v), false);
    });
  }
  for (const v of [MIN_BUDGET, 200, MAX_BUDGET]) {
    it(`accepts ${v}`, () => {
      assert.equal(isValidBudget(v), true);
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
    writeConfig(
      dir,
      JSON.stringify({ mode: "agent-driver", reviewBudget: 320, planPhase: false, exclusive: true }),
    );
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.mode, "agent-driver");
    assert.equal(loaded.config.reviewBudget, 320);
    assert.equal(loaded.config.planPhase, false);
    assert.equal(loaded.config.exclusive, true);
    assert.equal(loaded.legacyMode, undefined);
    assert.equal(loaded.migratedBudgetFrom, undefined);
  });

  it("drops an out-of-range value but keeps the rest of the file", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ mode: "agent-driver", reviewBudget: 0 }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.mode, "agent-driver");
    assert.equal(loaded.config.reviewBudget, DEFAULTS.reviewBudget);
  });

  it("ignores non-boolean flags rather than coercing them", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ planPhase: "yes", exclusive: 1 }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.planPhase, DEFAULTS.planPhase);
    assert.equal(loaded.config.exclusive, DEFAULTS.exclusive);
  });

  it("runs a human-driver config that older versions only warned about", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ mode: "human-driver", reviewModel: "x/y" }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.mode, "human-driver");
    assert.equal(loaded.legacyMode, undefined, "no longer a legacy mode");
    // and the raw object still carries the unknown field
    assert.equal(loaded.raw.reviewModel, "x/y");
  });

  it("still reports a mode it cannot run at all", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ mode: "telepathy" }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.mode, DEFAULTS.mode);
    assert.equal(loaded.legacyMode, undefined, "unknown is not the same as legacy");
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

describe("loadConfig: legacy budget migration", () => {
  it("derives reviewBudget from the old call-count key and reports it", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ [LEGACY_BUDGET_KEY]: 5 }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.reviewBudget, 5 * LEGACY_CHANGE_POINTS);
    assert.equal(loaded.migratedBudgetFrom, 5);
  });

  it("leaves the legacy key on disk so a downgrade still works", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ [LEGACY_BUDGET_KEY]: 5 }));
    loadConfig(dir);
    saveConfig(dir, { mode: "agent-driver" });
    const onDisk = JSON.parse(readFileSync(configPath(dir), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk[LEGACY_BUDGET_KEY], 5, "legacy key must survive a write");
  });

  it("prefers an explicit reviewBudget over the legacy key", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ reviewBudget: 300, [LEGACY_BUDGET_KEY]: 5 }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.reviewBudget, 300);
    assert.equal(loaded.migratedBudgetFrom, undefined, "no migration happened");
  });

  it("clamps a migrated value into range rather than falling back to the default", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ [LEGACY_BUDGET_KEY]: 1000 }));
    const loaded = loadConfig(dir);
    assert.equal(isValidBudget(loaded.config.reviewBudget), true);
    assert.equal(loaded.migratedBudgetFrom, 1000);
  });

  it("ignores an out-of-range legacy value", () => {
    const dir = tempProject();
    writeConfig(dir, JSON.stringify({ [LEGACY_BUDGET_KEY]: 0 }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.config.reviewBudget, DEFAULTS.reviewBudget);
    assert.equal(loaded.migratedBudgetFrom, undefined);
  });
});

describe("saveConfig", () => {
  it("round-trips and preserves unknown/legacy fields", () => {
    const dir = tempProject();
    writeConfig(
      dir,
      JSON.stringify({ mode: "human-driver", reviewModel: "a/b", futureSetting: { deep: true } }),
    );

    saveConfig(dir, { reviewBudget: 280 });

    const onDisk = JSON.parse(readFileSync(configPath(dir), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.reviewBudget, 280);
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
    assert.throws(() => saveConfig(dir, { reviewBudget: 0 }), ConfigWriteError);
    assert.throws(
      () => saveConfig(dir, { planPhase: "yes" as unknown as boolean }),
      ConfigWriteError,
    );
    assert.throws(
      () => saveConfig(dir, { mode: "telepathy" as unknown as "off" }),
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
    saveConfig(dir, { reviewBudget: 240 }, spy);
    saveConfig(dir, { reviewBudget: 280 }, spy);
    assert.equal(seen.size, 2, "temp paths must not collide");
  });
});

describe("modes", () => {
  it("accepts every mode this version can run", () => {
    for (const mode of MODES) assert.equal(isMode(mode), true, mode);
  });

  it("includes human-driver, and no longer treats it as legacy", () => {
    assert.ok(MODES.includes("human-driver"));
    assert.deepEqual([...LEGACY_MODES], [], "nothing is deferred any more");
  });

  it("rejects anything not in the list", () => {
    for (const v of ["", "driver", "HUMAN-DRIVER", null, undefined, 1, {}]) {
      assert.equal(isMode(v), false, JSON.stringify(v) ?? String(v));
    }
  });
});
