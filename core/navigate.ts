import { shouldReview, type ReviewGateCfg } from "./config.ts";

export type SchedulerState = "IDLE" | "PENDING" | "WAITING_INTERVAL" | "REVIEWING";

export type SchedulerCfg = ReviewGateCfg & { debounceSeconds: number };

export type SchedulerHooks = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  getChangedLines: () => number | Promise<number>;
  getDiffText: () => string | Promise<string>;
  /** Run a review; resolve ok/fail. Must not throw. */
  runReview: (diff: string, hash: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Emit text (findings or errors). Caller decides whether to queue. */
  onOutput: (text: string) => void;
};

export type Scheduler = {
  /** Notify of a content-sensitive state hash change. */
  notify: (hash: string) => void;
  getState: () => SchedulerState;
  getLatestHash: () => string;
  getReviewed: () => ReadonlySet<string>;
  /** Last review summary for /status. */
  getLastSummary: () => string;
  stop: () => void;
};

export function createScheduler(cfg: SchedulerCfg, hooks: SchedulerHooks): Scheduler {
  let state: SchedulerState = "IDLE";
  let timer: unknown = null;
  let lastSeen = "";
  let latestHash = "";
  let frozenHash = "";
  let lastReviewStartedAt = 0;
  const reviewed = new Set<string>();
  let lastSummary = "none yet";
  let stopped = false;

  const clearTimer = () => {
    if (timer != null) {
      hooks.clearTimeout(timer);
      timer = null;
    }
  };

  const setTimer = (fn: () => void, ms: number) => {
    clearTimer();
    timer = hooks.setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };

  const startDebounce = () => {
    state = "PENDING";
    setTimer(() => void onDebounceFire(), cfg.debounceSeconds * 1000);
  };

  async function onDebounceFire() {
    if (stopped) return;
    if (reviewed.has(latestHash)) {
      state = "IDLE";
      return;
    }
    const lines = await hooks.getChangedLines();
    const gate = shouldReview(lines, lastReviewStartedAt, hooks.now(), cfg);
    if (!gate.ok && gate.reason === "lines") {
      state = "IDLE";
      return;
    }
    if (!gate.ok && gate.reason === "interval") {
      state = "WAITING_INTERVAL";
      setTimer(() => void fire(), gate.waitMs ?? cfg.intervalSeconds * 1000);
      return;
    }
    await fire();
  }

  async function fire() {
    if (stopped) return;
    if (reviewed.has(latestHash)) {
      state = "IDLE";
      return;
    }
    // Re-check lines in case they dropped while waiting.
    const lines = await hooks.getChangedLines();
    if (lines < cfg.minLines) {
      state = "IDLE";
      return;
    }
    state = "REVIEWING";
    lastReviewStartedAt = hooks.now();
    frozenHash = latestHash;
    const diff = await hooks.getDiffText();
    const result = await hooks.runReview(diff, frozenHash);
    onReviewComplete(result);
  }

  function onReviewComplete(result: { ok: true } | { ok: false; error: string }) {
    if (stopped) return;
    if (result.ok) {
      reviewed.add(frozenHash);
      lastSummary = `ok @ ${frozenHash.slice(0, 8)}`;
    } else {
      hooks.onOutput(`── navigator error ── ${result.error}\n`);
      lastSummary = `error: ${result.error.slice(0, 80)}`;
    }

    // Drain if failed or the tree moved while this review was in flight.
    if (!result.ok || latestHash !== frozenHash) {
      startDebounce();
    } else {
      state = "IDLE";
    }
  }

  function notify(hash: string) {
    if (stopped) return;
    if (hash === lastSeen) return;
    lastSeen = hash;
    latestHash = hash;

    // REVIEWING check first — never break single-in-flight.
    if (state === "REVIEWING") return;

    if (reviewed.has(latestHash)) {
      clearTimer();
      state = "IDLE";
      return;
    }
    startDebounce();
  }

  return {
    notify,
    getState: () => state,
    getLatestHash: () => latestHash,
    getReviewed: () => reviewed,
    getLastSummary: () => lastSummary,
    stop: () => {
      stopped = true;
      clearTimer();
    },
  };
}

export { shouldReview };
