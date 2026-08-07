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

/** Modes this version can actually run. */
export type Mode = "off" | "agent-driver";

export const MODES: readonly Mode[] = ["off", "agent-driver"];

/**
 * Modes that older pear versions wrote and that we still recognise on disk.
 * Recognised so we can warn instead of silently coercing the user to `off`.
 */
export const LEGACY_MODES: readonly string[] = ["human-driver"];

export type PearConfig = {
  mode?: Mode;
  /**
   * Mutating tool calls allowed between checkpoints before the gate closes.
   * The agent is expected to checkpoint after each logical change well before
   * this; it is a backstop against drift, not the primary mechanism.
   */
  maxChangesPerCheckpoint?: number;
};

export const DEFAULTS = {
  mode: "off",
  maxChangesPerCheckpoint: 5,
} as const satisfies Required<PearConfig>;

/** Inclusive bounds for `maxChangesPerCheckpoint`. */
export const MIN_CHANGES = 1;
export const MAX_CHANGES = 1000;

/**
 * The entire gate rule, as a pure function.
 *
 * `max = 5` allows five mutating calls and blocks the sixth: the gate is
 * consulted *before* admitting a call, so it closes once `count` has already
 * reached `max`.
 */
export function gateClosed(count: number, max: number): boolean {
  return count >= max;
}

export function isMode(v: unknown): v is Mode {
  return v === "off" || v === "agent-driver";
}

export function isLegacyMode(v: unknown): v is string {
  return typeof v === "string" && LEGACY_MODES.includes(v);
}

/** Positive integer within the documented range. Rejects NaN, floats, strings. */
export function isValidMaxChanges(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_CHANGES &&
    v <= MAX_CHANGES
  );
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

  if (isMode(raw.mode)) {
    config.mode = raw.mode;
  } else if (isLegacyMode(raw.mode)) {
    legacyMode = raw.mode;
  }

  if (isValidMaxChanges(raw.maxChangesPerCheckpoint)) {
    config.maxChangesPerCheckpoint = raw.maxChangesPerCheckpoint;
  }

  return legacyMode === undefined
    ? { config, raw, malformed: false, missing: false }
    : { config, raw, malformed: false, missing: false, legacyMode };
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
  if (patch.maxChangesPerCheckpoint !== undefined && !isValidMaxChanges(patch.maxChangesPerCheckpoint)) {
    throw new ConfigWriteError(
      `refusing to persist invalid maxChangesPerCheckpoint ${JSON.stringify(patch.maxChangesPerCheckpoint)}` +
        ` (want an integer in [${MIN_CHANGES}, ${MAX_CHANGES}])`,
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

  const merged: Record<string, unknown> = { ...existing.raw };
  if (patch.mode !== undefined) merged.mode = patch.mode;
  if (patch.maxChangesPerCheckpoint !== undefined) {
    merged.maxChangesPerCheckpoint = patch.maxChangesPerCheckpoint;
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
