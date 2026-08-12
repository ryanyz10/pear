/**
 * pear configuration: `<projectDir>/.pear/config.json`.
 *
 * Design constraints that are easy to get wrong, so they are stated here:
 *
 * - **Nothing is ever silently destroyed.** Unknown keys (including settings
 *   from older/newer pear versions) round-trip verbatim through a save, and a
 *   file we cannot parse is never overwritten without first copying the
 *   original bytes to `config.json.corrupt-<timestamp>`.
 * - **Legacy modes are reported, not rewritten.** `human-driver` is not
 *   supported by this version, but a config containing it keeps that value on
 *   disk so re-adding the mode later is non-destructive. Callers see it via
 *   `legacyMode` and can warn.
 * - **There is no global (`~/.pear`) fallback.** It only ever supplied model
 *   choices, and this version makes no LLM calls.
 * - **All filesystem access goes through an injectable seam** so failure paths
 *   are testable deterministically rather than by chmod-ing directories (which
 *   behaves differently as root and across platforms).
 */

import {
  copyFileSync as realCopyFileSync,
  mkdirSync as realMkdirSync,
  readFileSync as realReadFileSync,
  renameSync as realRenameSync,
  unlinkSync as realUnlinkSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_READ_ONLY_COMMANDS } from "./bash.ts";
import { FILE_POINTS } from "./load.ts";

/** Modes this version can actually run. */
export type Mode = "off" | "agent-driver" | "human-driver";

export const MODES: readonly Mode[] = ["off", "agent-driver", "human-driver"];

/**
 * Modes that older pear versions wrote and that we still recognise on disk.
 * Recognised so we can warn instead of silently coercing the user to `off`.
 *
 * Empty as of v4: `human-driver` was here while it was unimplemented and has
 * moved into `MODES`. A config that previous versions warned about now runs.
 */
export const LEGACY_MODES: readonly string[] = [];

export type PearConfig = {
  mode?: Mode;
  /**
   * Review-load points allowed between checkpoints before one is due.
   * See `core/load.ts` for how points are priced.
   *
   * The agent is expected to checkpoint at coherent boundaries well before
   * this; the budget nags and then blocks as a backstop against drift, it is
   * not the primary mechanism.
   */
  reviewBudget?: number;
  /** Start each session in the scoping phase rather than going straight to building. */
  planPhase?: boolean;
  /** Prune tools that are neither pi built-ins nor pear's at session start. */
  exclusive?: boolean;
  /**
   * Commands that count as inspection: not priced, and allowed while scoping
   * or after a stop. Entries match leading tokens, so `git log` covers its
   * flags. See `core/bash.ts` — the list is the policy, and pear does not
   * second-guess what is on it.
   */
  allowedReadOnlyCommands?: readonly string[];
  /** Show a pear instead of the word, in the status line and the nudge. */
  statusIcon?: boolean;
  /** Human-driver: show the passive nudge above the prompt at all. */
  nudge?: boolean;
  /** Human-driver: how often the working tree is sampled, in milliseconds. */
  pollMs?: number;
  /** Human-driver: how long the tree must be quiet before it is priced. */
  debounceMs?: number;
  /** Human-driver: consecutive git failures before the watcher parks. */
  maxPollFailures?: number;
  /** Fraction of the budget at which pear starts mentioning it. */
  softFraction?: number;
  /** Multiple of the budget at which mutating calls are refused. */
  blockMultiple?: number;
};

export const DEFAULTS = {
  mode: "off",
  reviewBudget: 200,
  planPhase: true,
  exclusive: false,
  allowedReadOnlyCommands: DEFAULT_READ_ONLY_COMMANDS,
  statusIcon: false,
  nudge: true,
  pollMs: 2_000,
  debounceMs: 8_000,
  maxPollFailures: 5,
  softFraction: 0.5,
  blockMultiple: 2,
} as const satisfies Required<PearConfig>;

/**
 * Inclusive bounds for `reviewBudget`.
 *
 * The floor is one file charge: below that, the very first edit is always
 * over budget and the loop would checkpoint after every call.
 */
export const MIN_BUDGET = FILE_POINTS;
export const MAX_BUDGET = 100_000;

/**
 * The key older versions used, in mutating-tool-calls. Still read (migrated to
 * points) and still left on disk untouched, so downgrading is non-destructive.
 */
export const LEGACY_BUDGET_KEY = "maxChangesPerCheckpoint";

/**
 * How much review load one "change" was worth under the old call-counting
 * budget. A file charge is the closest honest equivalent: the old unit was
 * roughly "one edit somewhere".
 */
export const LEGACY_CHANGE_POINTS = FILE_POINTS;

/**
 * How much of the budget must be used before pear starts nagging, and how far
 * past it the agent gets before mutating tools are blocked outright.
 */
export const SOFT_FRACTION = DEFAULTS.softFraction;
export const BLOCK_MULTIPLE = DEFAULTS.blockMultiple;

/**
 * What pear does at a given review load.
 *
 * - `quiet`  — say nothing.
 * - `soft`   — mention it in passing on mutating tool results.
 * - `due`    — say plainly that a checkpoint is expected next.
 * - `blocked`— refuse further mutating calls until a checkpoint happens.
 *
 * The gate is *admit-first*: this is consulted with the load accumulated
 * **before** the call being considered, so a single oversized change always
 * executes and the block lands on the one after it. Blocking a call on its own
 * estimated cost would force a checkpoint with nothing yet to review.
 */
export type LoadTier = "quiet" | "soft" | "due" | "blocked";

export function loadTier(
  points: number,
  budget: number,
  soft: number = SOFT_FRACTION,
  block: number = BLOCK_MULTIPLE,
): LoadTier {
  if (points >= budget * block) return "blocked";
  if (points >= budget) return "due";
  if (points >= budget * soft) return "soft";
  return "quiet";
}

export function isMode(v: unknown): v is Mode {
  return v === "off" || v === "agent-driver" || v === "human-driver";
}

/** A whole number within an inclusive range. Rejects NaN, floats, strings. */
function isIntBetween(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** A finite number strictly inside an open range. */
function isNumberBetween(v: unknown, low: number, high: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > low && v < high;
}

export function isLegacyMode(v: unknown): v is string {
  return typeof v === "string" && LEGACY_MODES.includes(v);
}

/** Positive integer within the documented range. Rejects NaN, floats, strings. */
export function isValidBudget(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_BUDGET &&
    v <= MAX_BUDGET
  );
}

/** The old key's bounds, kept only so a legacy value can be recognised. */
export function isValidLegacyBudget(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000;
}

export type ConfigKey = keyof Required<PearConfig>;

/**
 * What each key accepts, in one place.
 *
 * `loadConfig` and `saveConfig` both consult this, which is the point: a key
 * that reads back differently from how it validates on write is how a config
 * silently loses a setting. `describe` is shown to the human — in a write
 * error, and in `/pear-config` — so it is written as a sentence, not a schema.
 */
export type ConfigSpec = {
  validate: (value: unknown) => boolean;
  /** What a valid value looks like, for humans. */
  describe: string;
  /** One line about what the key does, for `/pear-config`. */
  summary: string;
};

export const CONFIG_SPECS: Record<ConfigKey, ConfigSpec> = {
  mode: {
    validate: isMode,
    describe: MODES.join(" | "),
    summary: "who is driving, or off",
  },
  reviewBudget: {
    validate: isValidBudget,
    describe: `a whole number from ${MIN_BUDGET} to ${MAX_BUDGET}`,
    summary: "review points allowed between checkpoints",
  },
  planPhase: {
    validate: (v) => typeof v === "boolean",
    describe: "true or false",
    summary: "start in scoping, with editing closed until a plan is approved",
  },
  exclusive: {
    validate: (v) => typeof v === "boolean",
    describe: "true or false",
    summary: "turn off tools from other extensions at session start",
  },
  allowedReadOnlyCommands: {
    // Deliberately unvalidated beyond the shape: the list is the human's
    // policy, and pear does not get an opinion about what is on it.
    validate: (v) => Array.isArray(v) && v.every((e) => typeof e === "string"),
    describe: "a list of commands, matched on their leading words",
    summary: "commands that count as inspection rather than change",
  },
  statusIcon: {
    validate: (v) => typeof v === "boolean",
    describe: "true or false",
    summary: "show 🍐 instead of the word pear",
  },
  nudge: {
    validate: (v) => typeof v === "boolean",
    describe: "true or false",
    summary: "show the passive line above your prompt while you drive",
  },
  pollMs: {
    validate: (v) => isIntBetween(v, 250, 60_000),
    describe: "milliseconds, from 250 to 60000",
    summary: "how often your working tree is checked for changes",
  },
  debounceMs: {
    validate: (v) => isIntBetween(v, 500, 600_000),
    describe: "milliseconds, from 500 to 600000",
    summary: "how long the tree must be quiet before pear prices it",
  },
  maxPollFailures: {
    validate: (v) => isIntBetween(v, 1, 1_000),
    describe: "a whole number from 1 to 1000",
    summary: "consecutive git errors before pear stops watching",
  },
  softFraction: {
    // Strictly between 0 and 1 so the quiet/soft/due ordering cannot invert.
    validate: (v) => isNumberBetween(v, 0, 1),
    describe: "a fraction above 0 and below 1",
    summary: "share of the budget at which pear starts mentioning it",
  },
  blockMultiple: {
    // Strictly above 1, or "blocked" would swallow "due".
    validate: (v) => isNumberBetween(v, 1, 1_000),
    describe: "a number above 1",
    summary: "multiple of the budget at which changes are refused",
  },
};

export const CONFIG_KEYS = Object.keys(CONFIG_SPECS) as ConfigKey[];

export function isConfigKey(v: unknown): v is ConfigKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CONFIG_SPECS, v);
}

/** A value as a human types it, and as `/pear-config` shows it back. */
export function formatConfigValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * The same value, cut to one line.
 *
 * Option labels in a card and in `ui.select` are one line each: pi's selector
 * renders a long one as a wrapped `Text` whose continuation lines lose the
 * selection marker's indent, and even pear's own renderer would spend half the
 * card on a list of commands. So a long value is elided and its size named —
 * the full value belongs in the card body, which knows how to scroll.
 */
export function summariseConfigValue(value: unknown, width = 40): string {
  const full = formatConfigValue(value);
  if (full.length <= width) return full;
  const count = Array.isArray(value) ? ` (${value.length})` : "";
  const room = Math.max(1, width - count.length - 1);
  return `${full.slice(0, room).trimEnd()}…${count}`;
}

/** Keys whose value is a list, and so can be added to and removed from. */
export function isListKey(key: ConfigKey): boolean {
  return Array.isArray(DEFAULTS[key]);
}

/** The words that mean "put this key back how it shipped". */
const RESET_WORDS = ["default", "defaults", "reset"];

/**
 * What one edit of one setting did.
 *
 * `unchanged` and `absent` exist so the caller can say what happened without
 * writing anything: adding a command that is already on the list and removing
 * one that never was are both mistakes worth naming, and neither is a failure.
 */
export type ConfigEdit =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "unchanged"; entries: string[] }
  | { ok: false; reason: "absent"; entries: string[] };

/**
 * Read one edit out of what a human typed, against what the setting is now.
 *
 * Three forms on top of `parseConfigValue`, which still handles the plain
 * "here is the whole value" case:
 *
 * - `default` / `reset` — any key, back to what pear ships with.
 * - `+git log, rg` — list keys, append the entries that are not already there.
 * - `-rg` — list keys, drop those entries.
 *
 * The shorthand costs three literal list entries (`default`, `reset`, and
 * anything starting with `-`); they are still reachable by giving the whole
 * list, which is what the card's "replace" option does. Losing a list because
 * you meant to remove one thing from it is the worse trade.
 */
export function parseConfigEdit(
  key: ConfigKey,
  text: string,
  current: unknown,
): ConfigEdit {
  const trimmed = text.trim();

  if (RESET_WORDS.includes(trimmed.toLowerCase())) {
    return { ok: true, value: DEFAULTS[key] };
  }

  const sign = trimmed.startsWith("+") ? "add" : trimmed.startsWith("-") ? "remove" : "set";
  if (sign === "set") {
    const parsed = parseConfigValue(key, trimmed);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: "invalid" };
  }

  // `+`/`-` only mean anything for a list. On a number they would read as a
  // sign, which is exactly the ambiguity worth refusing.
  if (!isListKey(key)) return { ok: false, reason: "invalid" };

  const entries = trimmed
    .slice(1)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (entries.length === 0) return { ok: false, reason: "invalid" };

  const list = Array.isArray(current) ? (current as string[]).map(String) : [];

  if (sign === "add") {
    const fresh = entries.filter((e) => !list.includes(e));
    if (fresh.length === 0) return { ok: false, reason: "unchanged", entries };
    return { ok: true, value: [...list, ...fresh] };
  }

  const present = entries.filter((e) => list.includes(e));
  if (present.length === 0) return { ok: false, reason: "absent", entries };
  return { ok: true, value: list.filter((e) => !present.includes(e)) };
}

/**
 * Read one typed setting out of what a human typed.
 *
 * Every value arrives as a string — from a command argument or a text input —
 * so this is where a string becomes a boolean, a number, or a list. It ends by
 * running the same validator a write would, so the command line and the file
 * cannot disagree about what is acceptable.
 *
 * Lists are comma-separated because the entries contain spaces: `git log` is
 * one entry, not two.
 */
export function parseConfigValue(
  key: ConfigKey,
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  let value: unknown = trimmed;

  if (key === "allowedReadOnlyCommands") {
    value = trimmed === ""
      ? []
      : trimmed.split(",").map((e) => e.trim()).filter((e) => e !== "");
  } else if (typeof DEFAULTS[key] === "boolean") {
    const yes = ["true", "on", "yes", "1"].includes(trimmed.toLowerCase());
    const no = ["false", "off", "no", "0"].includes(trimmed.toLowerCase());
    if (!yes && !no) return { ok: false };
    value = yes;
  } else if (typeof DEFAULTS[key] === "number") {
    // Number("") is 0, which would quietly accept an empty input.
    if (trimmed === "") return { ok: false };
    value = Number(trimmed);
  }

  return CONFIG_SPECS[key].validate(value) ? { ok: true, value } : { ok: false };
}

export type LoadedConfig = {
  /** Sanitized, defaulted values safe to run with. */
  config: Required<PearConfig>;
  /**
   * A mode present on disk that this version cannot run (e.g. `human-driver`).
   * `config.mode` falls back to the default when this is set; the file is left
   * untouched.
   */
  legacyMode?: string;
  /** Raw parsed object, so a later save can preserve unknown keys. */
  raw: Record<string, unknown>;
  /** File existed but could not be parsed as a JSON object. */
  malformed: boolean;
  /** No config file present. */
  missing: boolean;
  /**
   * Set when `reviewBudget` was derived from the legacy
   * `maxChangesPerCheckpoint` key, so the caller can explain the new units
   * once. The legacy key is left on disk.
   */
  migratedBudgetFrom?: number;
};

export type ConfigFs = {
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
  copyFileSync: (from: string, to: string) => void;
};

export const nodeFs: ConfigFs = {
  readFileSync: (path) => realReadFileSync(path, "utf8"),
  writeFileSync: (path, data) => realWriteFileSync(path, data),
  mkdirSync: (path) => {
    realMkdirSync(path, { recursive: true });
  },
  renameSync: (from, to) => realRenameSync(from, to),
  unlinkSync: (path) => realUnlinkSync(path),
  copyFileSync: (from, to) => realCopyFileSync(from, to),
};

export function configDir(projectDir: string): string {
  return join(projectDir, ".pear");
}

export function configPath(projectDir: string): string {
  return join(configDir(projectDir), "config.json");
}

/**
 * Reads and sanitizes the project config.
 *
 * Never throws: a missing file, unreadable file, non-JSON content, or a JSON
 * value that isn't an object all resolve to defaults with `missing`/`malformed`
 * set so the caller can react.
 */
export function loadConfig(projectDir: string, fs: ConfigFs = nodeFs): LoadedConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath(projectDir));
  } catch {
    return {
      config: { ...DEFAULTS },
      raw: {},
      malformed: false,
      missing: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      config: { ...DEFAULTS },
      raw: {},
      malformed: true,
      missing: false,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      config: { ...DEFAULTS },
      raw: {},
      malformed: true,
      missing: false,
    };
  }

  const raw = parsed as Record<string, unknown>;
  const config: Required<PearConfig> = { ...DEFAULTS };
  let legacyMode: string | undefined;
  let migratedBudgetFrom: number | undefined;

  // Every key is read the same way it is written, from CONFIG_SPECS. A value
  // that fails validation is left at its default rather than rejected: one bad
  // key must not cost the human the rest of their config.
  const settable = config as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    const value = raw[key];
    if (value !== undefined && CONFIG_SPECS[key].validate(value)) settable[key] = value;
  }

  // A mode this version cannot run is reported rather than coerced, and the
  // file is left alone so re-adding the mode later is non-destructive.
  if (!isMode(raw.mode) && isLegacyMode(raw.mode)) legacyMode = raw.mode;

  // An explicit reviewBudget always wins. Only fall back to the legacy key when
  // there is no new one to honour, so a config carrying both is unambiguous.
  if (!isValidBudget(raw.reviewBudget) && isValidLegacyBudget(raw[LEGACY_BUDGET_KEY])) {
    const legacy = raw[LEGACY_BUDGET_KEY] as number;
    config.reviewBudget = clampBudget(legacy * LEGACY_CHANGE_POINTS);
    migratedBudgetFrom = legacy;
  }

  const loaded: LoadedConfig = { config, raw, malformed: false, missing: false };
  if (legacyMode !== undefined) loaded.legacyMode = legacyMode;
  if (migratedBudgetFrom !== undefined) loaded.migratedBudgetFrom = migratedBudgetFrom;
  return loaded;
}

/** Keeps a derived budget inside the documented range. */
function clampBudget(points: number): number {
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, points));
}

/** Thrown when a config write could not be completed. Callers must surface it. */
export class ConfigWriteError extends Error {
  cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ConfigWriteError";
    this.cause = cause;
  }
}

/**
 * Merges `patch` into the on-disk config and writes it atomically.
 *
 * - Unknown keys already in the file are preserved.
 * - Invalid values in `patch` are rejected outright (throwing), rather than
 *   silently dropped, because a patch comes from our own code paths.
 * - A malformed existing file is copied to `config.json.corrupt-<ts>` before
 *   being replaced, so no user data is lost.
 * - The write goes to a unique same-directory temp file and is then renamed,
 *   so a crash mid-write cannot leave a truncated config. The temp file is
 *   cleaned up if the rename fails.
 *
 * Concurrency: single-writer-per-process. Two processes writing concurrently
 * are last-write-wins and one may drop the other's fields; pear is a
 * single-user tool and deliberately does not lock. See README.
 *
 * @throws {ConfigWriteError}
 */
export function saveConfig(
  projectDir: string,
  patch: PearConfig,
  fs: ConfigFs = nodeFs,
  now: () => number = Date.now,
): void {
  // A patch comes from pear's own code paths, so an invalid value is a bug
  // rather than user error: it throws instead of being quietly dropped.
  const patched = patch as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    const value = patched[key];
    if (value === undefined || CONFIG_SPECS[key].validate(value)) continue;
    throw new ConfigWriteError(
      `refusing to persist invalid ${key} ${JSON.stringify(value)}` +
        ` (want ${CONFIG_SPECS[key].describe})`,
      undefined,
    );
  }

  const dir = configDir(projectDir);
  const target = configPath(projectDir);
  const existing = loadConfig(projectDir, fs);

  try {
    fs.mkdirSync(dir);
  } catch (e) {
    throw new ConfigWriteError(`could not create ${dir}`, e);
  }

  // Preserve the original bytes of a file we could not parse before replacing it.
  if (existing.malformed) {
    const backup = `${target}.corrupt-${now()}`;
    try {
      fs.copyFileSync(target, backup);
    } catch (e) {
      throw new ConfigWriteError(
        `refusing to overwrite unparseable ${target}: could not back it up to ${backup}`,
        e,
      );
    }
  }

  // Only keys explicitly present in the patch are written. Everything else in
  // the file — including the legacy budget key and settings from other pear
  // versions — round-trips verbatim.
  const merged: Record<string, unknown> = { ...existing.raw };
  for (const key of CONFIG_KEYS) {
    const value = patched[key];
    if (value !== undefined) merged[key] = value;
  }

  const tmp = join(dir, `config.json.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw new ConfigWriteError(`could not write ${tmp}`, e);
  }

  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort: leave no stray temp file */
    }
    throw new ConfigWriteError(`could not replace ${target}`, e);
  }
}
