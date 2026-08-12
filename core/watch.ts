/**
 * The human-driver watcher: decides *when* to nudge the human and when to ask
 * them to explain themselves.
 *
 * Host-free and fully injectable — clock, timers, and both git reads are
 * supplied by the caller. That is not fastidiousness: an earlier version of
 * this scheduler shipped with real timers and its races were untestable. Its
 * own notes ended up saying *"scheduler changes are race-prone — add fake-timer
 * tests for every state transition"*, which is only possible if the clock is a
 * parameter.
 *
 * ## The shape
 *
 * ```
 * IDLE ──sample differs──▶ SETTLING ──quiet for debounceMs──▶ measure
 *   ▲                          │                                 │
 *   │                          └── sample changes: restart       ├─ quiet ────▶ IDLE
 *   └──────────── acknowledge() ◀──────────────────────────────  ├─ soft/due ─▶ nudge
 *                                                                └─ blocked ──▶ trigger
 * ```
 *
 * Two reads with deliberately different costs: a cheap `sample()` every tick to
 * notice *that* something changed, and an expensive `measure()` only once the
 * tree has been quiet long enough to be worth pricing.
 *
 * ## Failure is bounded
 *
 * The predecessor to this module retried forever on error with no backoff. A
 * single misconfiguration produced 106 KB of identical log lines. So: after
 * `maxFailures` consecutive read failures the watcher **parks** — stops
 * polling, reports once, and waits to be restarted. Never a second identical
 * complaint.
 */

import { loadTier, type LoadTier } from "./config.ts";
import { pointsForWorkingTree } from "./load.ts";

/** What the watcher wants the host to do right now. */
export type WatchEffect =
  | { kind: "none" }
  /** Show or refresh the passive nudge. */
  | { kind: "nudge"; files: number; insertions: number; deletions: number; points: number; tier: LoadTier }
  /** Clear the nudge; there is nothing worth reporting. */
  | { kind: "clear" }
  /** Ask the human to explain themselves, by starting a turn. */
  | { kind: "trigger"; files: number; insertions: number; deletions: number; points: number }
  /** Repeated read failures; stop and say so once. */
  | { kind: "parked"; detail: string };

export type WatchSample = { ok: true; token: string } | { ok: false; detail: string };
export type WatchMeasure =
  | { ok: true; files: number; insertions: number; deletions: number }
  | { ok: false; detail: string };

export type WatchDeps = {
  /** Cheap: has anything changed? Returns an opaque token to compare. */
  sample: () => WatchSample;
  /** Expensive: how much has changed? Only called once the tree settles. */
  measure: () => WatchMeasure;
  /** Review-load points allowed before a checkpoint is due. */
  budget: () => number;
  now: () => number;
  /** Emit an effect for the host to carry out. */
  emit: (effect: WatchEffect) => void;
  /** Quiet period required before measuring. Default 8s. */
  debounceMs?: number;
  /** Consecutive read failures before parking. Default 5. */
  maxFailures?: number;
};

export const DEFAULT_DEBOUNCE_MS = 8_000;

/**
 * Five is enough to ride out a transient failure (a rebase moving `.git`, an
 * index.lock during a commit) without being enough to spam anyone.
 */
export const MAX_POLL_FAILURES = 5;

export type WatchState = "idle" | "settling" | "nudging" | "triggered" | "parked";

export type Watcher = {
  readonly state: WatchState;
  readonly failures: number;
  /** Points at the last measurement, for the status line. */
  readonly points: number;
  /**
   * Advance one poll tick. The host calls this on its interval; everything the
   * watcher wants done comes back through `emit`.
   */
  tick: () => void;
  /**
   * The changes have been reviewed. Resets to the tree's current state, so the
   * same work is never raised twice.
   */
  acknowledge: () => void;
  /**
   * Record a measurement the host took itself, so `/pear-explain` credits the
   * work it just raised. Without it a manual quiz acknowledges nothing and the
   * next keystroke re-raises the same tree.
   */
  observe: (points: number) => void;
  /**
   * The trigger was emitted but the question could not be delivered — the agent
   * was mid-turn, or the human was part-way through typing. Leaves the baseline
   * and the credit alone (nothing has been reviewed) and re-arms so the next
   * tick tries again.
   */
  rearm: () => void;
  /** Restart after parking, or after a mode/driver change. */
  restart: () => void;
  /** Stop emitting. Idempotent. */
  stop: () => void;
};

export function createWatcher(deps: WatchDeps): Watcher {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxFailures = deps.maxFailures ?? MAX_POLL_FAILURES;

  let state: WatchState = "idle";
  let stopped = false;
  /** Net load: what the agent has *not* been shown yet. Drives the tiers. */
  let points = 0;
  /** The last full measurement of the working tree. */
  let grossPoints = 0;
  /**
   * How much of `grossPoints` the agent has already been shown.
   *
   * Measurement is against HEAD, not against the last review, and a human
   * driver rarely commits between reviews — so without this credit, the two
   * keystrokes after explaining a 400-line change re-price all 400 and ask
   * about them again. The tiers must see only what is new.
   */
  let acknowledgedPoints = 0;

  /**
   * Counted separately, because they fail independently: `sample` succeeds on
   * every tick while `measure` runs only occasionally, so a shared counter
   * would let a healthy sample keep wiping a persistently broken measure.
   */
  let sampleFailures = 0;
  let measureFailures = 0;

  /** Whether a nudge is currently on screen — not the same as the state. */
  let nudgeShown = false;

  /** The tree as the agent last saw it. Everything is measured against this. */
  let baseline: string | null = null;
  /** The most recent sample, and when it first appeared. */
  let currentToken: string | null = null;
  let settledAt = 0;

  /**
   * The tree state the last measurement priced. Measuring is two git calls, so
   * a tree that settles to a state already priced is skipped entirely — without
   * this the watcher re-measures every `debounceMs` forever while the human
   * sits below the nudge threshold.
   */
  let measuredToken: string | null = null;

  const reset = (token: string | null): void => {
    baseline = token;
    currentToken = token;
    measuredToken = null;
    points = 0;
    state = "idle";
  };

  /** Take the nudge down, if one is up. Never emits a redundant clear. */
  const clearNudge = (): void => {
    if (!nudgeShown) return;
    nudgeShown = false;
    deps.emit({ kind: "clear" });
  };

  const park = (detail: string): void => {
    state = "parked";
    deps.emit({ kind: "parked", detail });
  };

  return {
    get state() {
      return state;
    },
    get failures() {
      return Math.max(sampleFailures, measureFailures);
    },
    get points() {
      return points;
    },

    tick() {
      if (stopped || state === "parked") return;

      const sample = deps.sample();
      if (!sample.ok) {
        sampleFailures++;
        if (sampleFailures >= maxFailures) park(sample.detail);
        return;
      }
      sampleFailures = 0;

      if (baseline === null) {
        // First tick of a session: adopt whatever is there as the baseline.
        // Work done before pear was watching is not the human's to explain.
        reset(sample.token);
        return;
      }

      // Restart the quiet period whenever the tree moves, rather than pricing
      // something the human is in the middle of editing.
      const moved = sample.token !== currentToken;
      currentToken = sample.token;
      if (moved) settledAt = deps.now();

      if (sample.token === baseline) {
        // Back to the reviewed state — a revert, or nothing has happened yet.
        if (state !== "idle") {
          state = "idle";
          points = 0;
          measuredToken = null;
        }
        clearNudge();
        return;
      }

      // Having asked once, wait to be answered. Re-asking a human who is
      // deliberately ignoring the question is how a nudge becomes a nag. This
      // sits above the `moved` branch on purpose: further edits must not
      // silently promote the state back out of `triggered`.
      if (state === "triggered") return;

      if (moved) {
        state = "settling";
        return;
      }

      // Already priced this exact tree; nothing new to say.
      if (sample.token === measuredToken) return;

      if (state === "idle") {
        // Unchanged since the last tick but never settled: begin the clock.
        settledAt = deps.now();
        state = "settling";
        return;
      }
      if (deps.now() - settledAt < debounceMs) return;

      const measured = deps.measure();
      if (!measured.ok) {
        measureFailures++;
        if (measureFailures >= maxFailures) park(measured.detail);
        return;
      }
      measureFailures = 0;
      measuredToken = sample.token;

      grossPoints = pointsForWorkingTree(measured);
      // A tree smaller than what was credited means a commit or a revert: the
      // credit no longer corresponds to anything on disk, so it has to go or it
      // would suppress everything after it.
      if (grossPoints < acknowledgedPoints) acknowledgedPoints = 0;
      points = grossPoints - acknowledgedPoints;
      const { files, insertions, deletions } = measured;
      const tier = loadTier(points, deps.budget());

      if (tier === "quiet") {
        state = "idle";
        clearNudge();
        return;
      }

      if (tier === "blocked") {
        state = "triggered";
        deps.emit({ kind: "trigger", files, insertions, deletions, points });
        return;
      }

      // soft or due: keep it quiet. Re-emitted whenever the tree settles into a
      // new state, so the counts on screen stay current as the human works.
      state = "nudging";
      nudgeShown = true;
      deps.emit({ kind: "nudge", files, insertions, deletions, points, tier });
    },

    observe(next) {
      grossPoints = next;
    },

    rearm() {
      if (state !== "triggered") return;
      state = "settling";
      // Forget the pricing, or the dedup check would skip re-measuring this
      // exact tree and the question would never be asked again.
      measuredToken = null;
    },

    acknowledge() {
      // Credit what was measured when the question was asked, not the tree as
      // it stands now: anything the human typed while the agent was replying is
      // theirs still to explain. Erring toward raising it again is the safe
      // direction.
      acknowledgedPoints = grossPoints;
      const sample = deps.sample();
      // A failed read here must not strand the old baseline; dropping to null
      // makes the next successful tick re-adopt the tree.
      reset(sample.ok ? sample.token : null);
      // Always emitted: acknowledging is also how a trigger is dismissed, and
      // the host may have UI up that a nudge-only clear would leave behind.
      nudgeShown = false;
      deps.emit({ kind: "clear" });
    },

    restart() {
      stopped = false;
      sampleFailures = 0;
      measureFailures = 0;
      nudgeShown = false;
      grossPoints = 0;
      acknowledgedPoints = 0;
      reset(null);
    },

    stop() {
      stopped = true;
      state = "idle";
    },
  };
}
