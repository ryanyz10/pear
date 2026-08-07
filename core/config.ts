import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Mode = "off" | "human-driver" | "agent-driver";

export type PearConfig = {
  mode?: Mode;
  reviewModel?: string; // human-driver: small/fast model that generates findings
  filterModel?: string; // human-driver: large model that filters those findings
  checkpointModel?: string; // agent-driver (pi/omp only): fast model that judges whether the current diff is a good stopping point (optional — unset resolves to the same default as reviewModel/filterModel; if that default or an explicitly-set model is unresolvable in the registry, falls back to today's deterministic pause)
  minLines?: number; // human-driver: min changed lines before a review fires
  debounceSeconds?: number; // human-driver: quiet period after last edit
  intervalSeconds?: number; // human-driver: min seconds between reviews
  checkpointSeconds?: number; // agent-driver: wall-clock cadence before forced pause
  maxChangesPerCheckpoint?: number; // agent-driver: mutating tool-calls before consulting the checkpoint judge, or pausing directly if no judge is configured/resolves
};

export const DEFAULTS = {
  mode: "off",
  reviewModel: "openai/gpt-5.6-terra",
  filterModel: "openai/gpt-5.6-sol",
  checkpointModel: "openai/gpt-5.6-terra",
  minLines: 50,
  debounceSeconds: 10,
  intervalSeconds: 60,
  checkpointSeconds: 300,
  maxChangesPerCheckpoint: 5,
} as const satisfies Required<PearConfig>;

/** Pure OR gate for the agent-driver checkpoint cadence. */
export function checkpointDue(
  current: { elapsedMs: number; changes: number },
  cfg: { checkpointSeconds: number; maxChangesPerCheckpoint: number },
): boolean {
  return (
    current.elapsedMs >= cfg.checkpointSeconds * 1000 ||
    current.changes >= cfg.maxChangesPerCheckpoint
  );
}

export type ReviewGateCfg = { minLines: number; intervalSeconds: number };

/** Pure threshold gate for the navigator. */
export function shouldReview(
  linesChanged: number,
  lastReviewStartedAt: number,
  now: number,
  cfg: ReviewGateCfg,
): { ok: true } | { ok: false; reason: "lines" | "interval"; waitMs?: number } {
  if (linesChanged < cfg.minLines) return { ok: false, reason: "lines" };
  const elapsed = now - lastReviewStartedAt;
  const need = cfg.intervalSeconds * 1000;
  if (lastReviewStartedAt > 0 && elapsed < need) {
    return { ok: false, reason: "interval", waitMs: need - elapsed };
  }
  return { ok: true };
}

export function parseModel(spec: string): { provider: string; id: string } {
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) {
    throw new Error(`Invalid --model '${spec}'; expected provider/id (e.g. anthropic/claude-sonnet-4-5)`);
  }
  return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

export type PearUserConfig = PearConfig;

function isMode(v: unknown): v is Mode {
  return v === "off" || v === "human-driver" || v === "agent-driver";
}

const POSITIVE_INT_FIELDS = [
  "minLines",
  "debounceSeconds",
  "intervalSeconds",
  "checkpointSeconds",
  "maxChangesPerCheckpoint",
] as const;
const MODEL_FIELDS = ["reviewModel", "filterModel", "checkpointModel"] as const;

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Validates each `PearConfig` field independently against the full schema:
 * `mode` must be one of the three literals, the cadence fields must be
 * positive integers, and the model fields must pass `parseModel`. An invalid
 * field is dropped; the rest of a valid object is kept. Unknown/legacy keys
 * are silently ignored. Shared by `loadUserConfig` and `saveUserConfig` so
 * neither can persist or read back a field the other would reject.
 */
function sanitizePearConfig(raw: Record<string, unknown>): PearUserConfig {
  const out: PearUserConfig = {};
  if (isMode(raw.mode)) out.mode = raw.mode;
  for (const field of POSITIVE_INT_FIELDS) {
    if (isPositiveInt(raw[field])) out[field] = raw[field] as number;
  }
  for (const field of MODEL_FIELDS) {
    if (typeof raw[field] === "string") {
      try {
        parseModel(raw[field] as string);
        out[field] = raw[field] as string;
      } catch {
        /* drop invalid model spec, keep the rest of the object */
      }
    }
  }
  return out;
}

/**
 * Reads `<baseDir>/.pear/config.json`. Missing or malformed JSON → `{}`.
 * Each field is validated independently via `sanitizePearConfig`: an invalid
 * field is dropped while the rest of a valid file is kept.
 */
export function loadUserConfig(baseDir: string): PearUserConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(baseDir, ".pear", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
  return sanitizePearConfig(raw);
}

/**
 * Writes `<baseDir>/.pear/config.json`, creating the `.pear` dir if needed.
 * `cfg` is sanitized through the same per-field validation as
 * `loadUserConfig` before being written, so an invalid field is dropped
 * rather than persisted.
 */
export function saveUserConfig(baseDir: string, cfg: PearUserConfig): void {
  const sanitized = sanitizePearConfig(cfg);
  mkdirSync(join(baseDir, ".pear"), { recursive: true });
  writeFileSync(join(baseDir, ".pear", "config.json"), JSON.stringify(sanitized, null, 2) + "\n");
}

/**
 * Resolves the effective config: `DEFAULTS`, overlaid with `{ reviewModel,
 * filterModel }` from the global config, then overlaid with every field from
 * the project config. Project wins on every field; global only ever
 * contributes model choice; `mode` has no global fallback.
 */
export function resolveConfig(projectDir: string, homeDir: string): Required<PearConfig> {
  const global = loadUserConfig(homeDir);
  const project = loadUserConfig(projectDir);
  return {
    mode: project.mode ?? DEFAULTS.mode,
    reviewModel: project.reviewModel ?? global.reviewModel ?? DEFAULTS.reviewModel,
    filterModel: project.filterModel ?? global.filterModel ?? DEFAULTS.filterModel,
    checkpointModel: project.checkpointModel ?? global.checkpointModel ?? DEFAULTS.checkpointModel,
    minLines: project.minLines ?? DEFAULTS.minLines,
    debounceSeconds: project.debounceSeconds ?? DEFAULTS.debounceSeconds,
    intervalSeconds: project.intervalSeconds ?? DEFAULTS.intervalSeconds,
    checkpointSeconds: project.checkpointSeconds ?? DEFAULTS.checkpointSeconds,
    maxChangesPerCheckpoint: project.maxChangesPerCheckpoint ?? DEFAULTS.maxChangesPerCheckpoint,
  };
}
