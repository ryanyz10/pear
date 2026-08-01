export type Config = {
  cwd: string;
  driveModel: string;
  navModel: string;
  pauseLines: number;
  pauseEdits: number;
  minLines: number;
  debounceSeconds: number;
  intervalSeconds: number;
  noNav: boolean;
  isGit: boolean;
};

export const DEFAULTS = {
  driveModel: "openai/gpt-5.6-terra",
  navModel: "openai/gpt-5.6-terra",
  pauseLines: 150,
  pauseEdits: 5,
  minLines: 50,
  debounceSeconds: 10,
  intervalSeconds: 60,
} as const;

export type BudgetStats = { lines: number; mutations: number };
export type BudgetCfg = { pauseLines: number; pauseEdits: number };

export function overBudget(
  current: BudgetStats,
  baseline: BudgetStats,
  cfg: BudgetCfg,
): boolean {
  return (
    current.lines - baseline.lines >= cfg.pauseLines ||
    current.mutations - baseline.mutations >= cfg.pauseEdits
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
