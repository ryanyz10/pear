import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_DEBOUNCE_MS, MAX_POLL_FAILURES, createWatcher, type WatchEffect } from "../core/watch.ts";
import { FILE_POINTS } from "../core/load.ts";

/**
 * A fake clock and scriptable git reads. Everything here is deterministic — the
 * whole reason the scheduler takes its clock as a parameter is that its
 * predecessor's races were untestable with real timers.
 */
function harness(opts: { budget?: number } = {}) {
  let clock = 0;
  let token = "A";
  let sampleFails: string | null = null;
  let measureFails: string | null = null;
  let stats = { files: 0, insertions: 0, deletions: 0 };
  const effects: WatchEffect[] = [];
  let measureCalls = 0;

  const watcher = createWatcher({
    sample: () => (sampleFails === null ? { ok: true, token } : { ok: false, detail: sampleFails }),
    measure: () => {
      measureCalls++;
      return measureFails === null ? { ok: true, ...stats } : { ok: false, detail: measureFails };
    },
    budget: () => opts.budget ?? 200,
    now: () => clock,
    emit: (e) => effects.push(e),
  });

  const api = {
    watcher,
    effects,
    measureCalls: () => measureCalls,
    /** Advance the clock without polling. */
    advance: (ms: number) => {
      clock += ms;
    },
    /** One poll tick, 2s after the last. */
    tick: () => {
      clock += 2000;
      watcher.tick();
    },
    /** Poll until past the debounce window. */
    settle: () => {
      for (let i = 0; i < 6; i++) api.tick();
    },
    edit: (next: string, next_stats?: Partial<typeof stats>) => {
      token = next;
      if (next_stats) stats = { ...stats, ...next_stats };
    },
    setStats: (s: Partial<typeof stats>) => {
      stats = { ...stats, ...s };
    },
    breakSample: (detail: string | null) => {
      sampleFails = detail;
    },
    breakMeasure: (detail: string | null) => {
      measureFails = detail;
    },
    last: () => effects[effects.length - 1],
    kinds: () => effects.map((e) => e.kind),
  };
  return api;
}

/** Stats that price to a given tier against a budget of 200. */
const QUIET = { files: 1, insertions: 5, deletions: 0 }; // 45
const SOFT = { files: 2, insertions: 40, deletions: 10 }; // 130
const BLOCKED = { files: 4, insertions: 200, deletions: 60 }; // 420

describe("adopting a baseline", () => {
  it("adopts whatever is already there on the first tick", () => {
    // Work done before pear was watching is not the human's to explain.
    const h = harness();
    h.setStats(BLOCKED);
    h.tick();
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.watcher.state, "idle");
  });

  it("stays quiet while nothing changes", () => {
    const h = harness();
    h.tick();
    h.settle();
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.measureCalls(), 0, "a still tree is never priced");
  });
});

describe("debounce", () => {
  it("does not measure until the tree has been quiet long enough", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.tick(); // notices the change, starts the clock
    assert.equal(h.watcher.state, "settling");

    h.tick(); // 2s
    h.tick(); // 4s
    assert.equal(h.measureCalls(), 0, "still within the quiet period");
  });

  it("measures once the quiet period elapses", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    assert.equal(h.measureCalls(), 1);
    assert.equal(h.last()?.kind, "nudge");
  });

  it("restarts the quiet period every time the tree moves", () => {
    // This is what stops a nudge landing mid-keystroke.
    const h = harness();
    h.tick();
    for (const t of ["B", "C", "D", "E", "F", "G"]) {
      h.edit(t, SOFT);
      h.tick();
    }
    assert.equal(h.measureCalls(), 0, "never settled long enough to price");
    assert.equal(h.watcher.state, "settling");

    h.settle();
    assert.equal(h.measureCalls(), 1);
  });

  it("uses the documented default quiet period", () => {
    assert.equal(DEFAULT_DEBOUNCE_MS, 8000);
  });
});

describe("tiers", () => {
  it("says nothing below the soft threshold", () => {
    const h = harness();
    h.tick();
    h.edit("B", QUIET);
    h.settle();
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.watcher.state, "idle");
  });

  it("nudges in the soft tier", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();

    const effect = h.last();
    assert.equal(effect?.kind, "nudge");
    assert.equal(effect.kind === "nudge" && effect.tier, "soft");
    assert.equal(effect.kind === "nudge" && effect.files, 2);
    assert.equal(effect.kind === "nudge" && effect.insertions, 40);
    assert.equal(effect.kind === "nudge" && effect.deletions, 10);
    assert.equal(effect.kind === "nudge" && effect.points, 2 * FILE_POINTS + 50);
  });

  it("nudges more firmly in the due tier without triggering", () => {
    const h = harness();
    h.tick();
    h.edit("B", { files: 3, insertions: 100, deletions: 20 }); // 240
    h.settle();

    const effect = h.last();
    assert.equal(effect?.kind, "nudge");
    assert.equal(effect.kind === "nudge" && effect.tier, "due");
  });

  it("triggers in the blocked tier", () => {
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.settle();

    const effect = h.last();
    assert.equal(effect?.kind, "trigger");
    assert.equal(effect.kind === "trigger" && effect.points, 4 * FILE_POINTS + 260);
    assert.equal(h.watcher.state, "triggered");
  });

  it("escalates from nudge to trigger as the work grows", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    h.edit("C", BLOCKED);
    h.settle();
    assert.deepEqual(h.kinds(), ["nudge", "trigger"]);
  });

  it("respects a custom budget", () => {
    const h = harness({ budget: 1000 });
    h.tick();
    h.edit("B", BLOCKED); // 420 — blocked at 200, quiet at 1000
    h.settle();
    assert.deepEqual(h.kinds(), []);
  });
});

describe("not re-asking", () => {
  it("does not re-price a tree it already measured", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    assert.equal(h.measureCalls(), 1);

    h.settle();
    h.settle();
    assert.equal(h.measureCalls(), 1, "the tree has not moved; nothing to re-price");
    assert.deepEqual(h.kinds(), ["nudge"]);
  });

  it("does not trigger twice while the human ignores it", () => {
    // Re-asking someone who is deliberately not answering is how a nudge
    // becomes a nag.
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.settle();

    for (const t of ["C", "D", "E"]) {
      h.edit(t, BLOCKED);
      h.settle();
    }
    assert.deepEqual(h.kinds(), ["trigger"]);
  });

  it("re-prices once the tree actually moves", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    h.edit("C", { files: 3, insertions: 60, deletions: 10 });
    h.settle();

    assert.deepEqual(h.kinds(), ["nudge", "nudge"]);
    const effect = h.last();
    assert.equal(effect.kind === "nudge" && effect.files, 3);
  });
});

describe("reverting", () => {
  it("clears the nudge when the tree returns to the reviewed state", () => {
    const h = harness();
    h.tick(); // baseline "A"
    h.edit("B", SOFT);
    h.settle();
    assert.equal(h.last()?.kind, "nudge");

    h.edit("A", { files: 0, insertions: 0, deletions: 0 });
    h.tick();
    h.tick();
    assert.equal(h.last()?.kind, "clear");
    assert.equal(h.watcher.state, "idle");
    assert.equal(h.watcher.points, 0);
  });

  it("clears only once, not on every subsequent tick", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    h.edit("A", { files: 0, insertions: 0, deletions: 0 });
    h.settle();
    h.settle();
    assert.deepEqual(h.kinds(), ["nudge", "clear"]);
  });

  it("clears the nudge when work drops back below the soft tier", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    h.edit("C", QUIET);
    h.settle();
    assert.deepEqual(h.kinds(), ["nudge", "clear"]);
  });
});

describe("acknowledge", () => {
  it("resets to the current tree and clears the nudge", () => {
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.settle();
    assert.equal(h.watcher.state, "triggered");

    h.watcher.acknowledge();
    assert.equal(h.watcher.state, "idle");
    assert.equal(h.watcher.points, 0);
    assert.equal(h.last()?.kind, "clear");
  });

  it("does not re-raise work that was already reviewed", () => {
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.settle();
    h.watcher.acknowledge();

    h.settle();
    h.settle();
    assert.deepEqual(h.kinds(), ["trigger", "clear"], "nothing new since the review");
  });

  it("raises only work done after the review", () => {
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.settle();
    h.watcher.acknowledge();

    h.edit("C", SOFT);
    h.settle();
    assert.deepEqual(h.kinds(), ["trigger", "clear", "nudge"]);
  });

  it("credits reviewed work, so a keystroke after it stays quiet", () => {
    // The measurement is against HEAD and a human driver rarely commits between
    // reviews, so the reviewed 420 points are still in the tree. Re-pricing
    // them would re-ask about work just explained.
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED); // 420
    h.settle();
    h.watcher.acknowledge();

    h.edit("C", { insertions: 202 }); // 422 gross, 2 net
    h.settle();
    assert.deepEqual(h.kinds(), ["trigger", "clear"], "two lines is not a new batch");
    assert.equal(h.watcher.points, 2);
  });

  it("still raises a genuine new batch on top of credited work", () => {
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED); // 420
    h.settle();
    h.watcher.acknowledge();

    h.edit("C", { files: 8, insertions: 400, deletions: 120 }); // 840 gross, 420 net
    h.settle();
    assert.deepEqual(h.kinds(), ["trigger", "clear", "trigger"]);
  });

  it("drops the credit when the tree shrinks, so a commit does not mute it", () => {
    // Committing collapses the tree. Keeping the old credit would suppress
    // everything the human wrote afterwards, forever.
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED); // 420
    h.settle();
    h.watcher.acknowledge();

    h.edit("C", { files: 0, insertions: 0, deletions: 0 }); // committed
    h.settle();
    h.edit("D", BLOCKED); // a fresh 420
    h.settle();
    assert.deepEqual(h.kinds(), ["trigger", "clear", "trigger"]);
  });

  it("credits a measurement the host took itself", () => {
    // `/pear-explain` measures directly and never goes through `tick`.
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.watcher.observe(420);
    h.watcher.acknowledge();

    h.edit("C", { insertions: 202 });
    h.settle();
    assert.deepEqual(h.kinds(), ["clear"], "no trigger for work already explained");
  });

  it("survives a failing read by re-adopting the tree on the next tick", () => {
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.settle();

    h.breakSample("index.lock");
    h.watcher.acknowledge();
    h.breakSample(null);

    h.settle();
    assert.equal(h.watcher.state, "idle", "re-adopted rather than stranded");
  });
});

describe("rearm", () => {
  it("re-asks after an undeliverable trigger", () => {
    // The watcher parks on `triggered` waiting to be answered. If the host
    // could not deliver the question, nothing will ever answer it.
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED);
    h.settle();
    assert.equal(h.watcher.state, "triggered");

    h.watcher.rearm();
    h.settle();
    assert.deepEqual(h.kinds(), ["trigger", "trigger"], "same tree, asked again");
  });

  it("credits nothing, so the work stays the human's to explain", () => {
    const h = harness();
    h.tick();
    h.edit("B", BLOCKED); // 420
    h.settle();
    h.watcher.rearm();
    h.settle();
    assert.equal(h.watcher.points, 420, "undelivered is not reviewed");
  });

  it("does nothing when no trigger is outstanding", () => {
    const h = harness();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    h.watcher.rearm();
    assert.equal(h.watcher.state, "nudging", "a nudge needs no rescuing");
  });
});

describe("parking on repeated failure", () => {
  it("rides out a transient failure", () => {
    const h = harness();
    h.tick();
    h.breakSample("transient");
    h.tick();
    h.tick();
    h.breakSample(null);
    assert.equal(h.watcher.state, "idle");
    assert.deepEqual(h.kinds(), []);
  });

  it("resets the streak on any successful read", () => {
    const h = harness();
    h.tick();
    for (let i = 0; i < MAX_POLL_FAILURES - 1; i++) {
      h.breakSample("flaky");
      h.tick();
    }
    h.breakSample(null);
    h.tick();
    assert.equal(h.watcher.failures, 0);

    for (let i = 0; i < MAX_POLL_FAILURES - 1; i++) {
      h.breakSample("flaky");
      h.tick();
    }
    assert.notEqual(h.watcher.state, "parked", "the streak restarted");
  });

  it("parks after the failure limit", () => {
    const h = harness();
    h.tick();
    h.breakSample("fatal: not a git repository");
    for (let i = 0; i < MAX_POLL_FAILURES; i++) h.tick();

    assert.equal(h.watcher.state, "parked");
    const effect = h.last();
    assert.equal(effect?.kind, "parked");
    assert.match(effect.kind === "parked" ? effect.detail : "", /not a git repository/);
  });

  it("complains exactly once, however long it stays broken", () => {
    // The predecessor produced 106 KB of identical log lines here.
    const h = harness();
    h.tick();
    h.breakSample("boom");
    for (let i = 0; i < 200; i++) h.tick();
    assert.deepEqual(h.kinds(), ["parked"]);
  });

  it("stops polling entirely once parked", () => {
    const h = harness();
    h.tick();
    h.breakSample("boom");
    for (let i = 0; i < MAX_POLL_FAILURES; i++) h.tick();

    h.breakSample(null);
    h.edit("B", BLOCKED);
    for (let i = 0; i < 20; i++) h.tick();
    assert.deepEqual(h.kinds(), ["parked"], "parked means parked");
  });

  it("parks on a failing measurement too, not just a failing sample", () => {
    const h = harness();
    h.tick();
    h.breakMeasure("fatal: bad revision");
    for (let i = 0; i < MAX_POLL_FAILURES; i++) {
      h.edit(`t${i}`, SOFT);
      h.settle();
    }
    assert.equal(h.watcher.state, "parked");
  });

  it("restart clears the park and re-adopts the tree", () => {
    const h = harness();
    h.tick();
    h.breakSample("boom");
    for (let i = 0; i < MAX_POLL_FAILURES; i++) h.tick();
    assert.equal(h.watcher.state, "parked");

    h.breakSample(null);
    h.watcher.restart();
    assert.equal(h.watcher.state, "idle");
    assert.equal(h.watcher.failures, 0);

    h.tick();
    h.edit("B", SOFT);
    h.settle();
    assert.equal(h.last()?.kind, "nudge", "watching again");
  });
});

describe("stop", () => {
  it("emits nothing after stopping", () => {
    const h = harness();
    h.tick();
    h.watcher.stop();
    h.edit("B", BLOCKED);
    h.settle();
    assert.deepEqual(h.kinds(), []);
  });

  it("is idempotent", () => {
    const h = harness();
    h.watcher.stop();
    assert.doesNotThrow(() => h.watcher.stop());
  });

  it("can be resumed by restart", () => {
    const h = harness();
    h.tick();
    h.watcher.stop();
    h.watcher.restart();
    h.tick();
    h.edit("B", SOFT);
    h.settle();
    assert.equal(h.last()?.kind, "nudge");
  });
});
