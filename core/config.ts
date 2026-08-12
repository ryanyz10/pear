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
};

export const DEFAULTS = {
  mode: "off",
  reviewBudget: 200,
  planPhase: true,
  exclusive: false,
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
export const SOFT_FRACTION = 0.5;
export const BLOCK_MULTIPLE = 2;

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

export function loadTier(points: number, budget: number): LoadTier {
  if (points >= budget * BLOCK_MULTIPLE) return "blocked";
  if (points >= budget) return "due";
  if (points >= budget * SOFT_FRACTION) return "soft";
  return "quiet";
}

export function isMode(v: unknown): v is Mode {
  return v === "off" || v === "agent-driver" || v === "human-driver";
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

  if (isMode(raw.mode)) {
    config.mode = raw.mode;
  } else if (isLegacyMode(raw.mode)) {
    legacyMode = raw.mode;
  }

  // An explicit reviewBudget always wins. Only fall back to the legacy key when
  // there is no new one to honour, so a config carrying both is unambiguous.
  if (isValidBudget(raw.reviewBudget)) {
    config.reviewBudget = raw.reviewBudget;
  } else if (isValidLegacyBudget(raw[LEGACY_BUDGET_KEY])) {
    const legacy = raw[LEGACY_BUDGET_KEY] as number;
    config.reviewBudget = clampBudget(legacy * LEGACY_CHANGE_POINTS);
    migratedBudgetFrom = legacy;
  }

  if (typeof raw.planPhase === "boolean") config.planPhase = raw.planPhase;
  if (typeof raw.exclusive === "boolean") config.exclusive = raw.exclusive;

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
  if (patch.mode !== undefined && !isMode(patch.mode)) {
    throw new ConfigWriteError(`refusing to persist invalid mode ${JSON.stringify(patch.mode)}`, undefined);
  }
  if (patch.reviewBudget !== undefined && !isValidBudget(patch.reviewBudget)) {
    throw new ConfigWriteError(
      `refusing to persist invalid reviewBudget ${JSON.stringify(patch.reviewBudget)}` +
        ` (want an integer in [${MIN_BUDGET}, ${MAX_BUDGET}])`,
      undefined,
    );
  }
  for (const key of ["planPhase", "exclusive"] as const) {
    const value = patch[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new ConfigWriteError(
        `refusing to persist invalid ${key} ${JSON.stringify(value)} (want a boolean)`,
        undefined,
      );
    }
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
  if (patch.mode !== undefined) merged.mode = patch.mode;
  if (patch.reviewBudget !== undefined) merged.reviewBudget = patch.reviewBudget;
  if (patch.planPhase !== undefined) merged.planPhase = patch.planPhase;
  if (patch.exclusive !== undefined) merged.exclusive = patch.exclusive;

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
