import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createScheduler, type SchedulerHooks } from "../core/navigate.ts";

type Fake = {
  now: number;
  timers: Map<number, { at: number; fn: () => void }>;
  nextId: number;
  lines: number;
  diffs: Map<string, string>;
  reviews: { hash: string; ok: boolean }[];
  outputs: string[];
  reviewImpl: (diff: string, hash: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

function harness(cfg = { minLines: 50, intervalSeconds: 0, debounceSeconds: 10 }) {
  const fake: Fake = {
    now: 1_000_000,
    timers: new Map(),
    nextId: 1,
    lines: 100,
    diffs: new Map(),
    reviews: [],
    outputs: [],
    reviewImpl: async (_d, hash) => {
      fake.reviews.push({ hash, ok: true });
      return { ok: true };
    },
  };

  const hooks: SchedulerHooks = {
    now: () => fake.now,
    setTimeout: (fn, ms) => {
      const id = fake.nextId++;
      fake.timers.set(id, { at: fake.now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      fake.timers.delete(id as number);
    },
    getChangedLines: async () => fake.lines,
    getDiffText: async () => "diff",
    runReview: (diff, hash) => fake.reviewImpl(diff, hash),
    onOutput: (t) => fake.outputs.push(t),
  };

  const sched = createScheduler(cfg, hooks);

  const advance = async (ms: number) => {
    const target = fake.now + ms;
    // Fire timers in order, allowing async fire() to schedule more.
    for (let guard = 0; guard < 100; guard++) {
      const due = [...fake.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) {
        fake.now = target;
        return;
      }
      const [id, t] = due[0]!;
      fake.timers.delete(id);
      fake.now = t.at;
      t.fn();
      // Let microtasks (async fire) settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return { fake, sched, advance, cfg };
}

describe("scheduler races", () => {
  it("fires after debounce when over threshold", async () => {
    const { fake, sched, advance } = harness();
    sched.notify("A");
    assert.equal(sched.getState(), "PENDING");
    await advance(10_000);
    assert.equal(fake.reviews.length, 1);
    assert.equal(fake.reviews[0]!.hash, "A");
    assert.ok(sched.getReviewed().has("A"));
    assert.equal(sched.getState(), "IDLE");
  });

  it("change during REVIEWING drains pending on completion", async () => {
    const { fake, sched, advance } = harness();
    let release!: (v: { ok: true }) => void;
    fake.reviewImpl = (_d, hash) =>
      new Promise((r) => {
        fake.reviews.push({ hash, ok: true });
        release = r as (v: { ok: true }) => void;
      });

    sched.notify("A");
    await advance(10_000);
    assert.equal(sched.getState(), "REVIEWING");
    sched.notify("B"); // pending during review
    assert.equal(sched.getState(), "REVIEWING");
    release!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sched.getState(), "PENDING"); // drain
    await advance(10_000);
    assert.equal(fake.reviews.map((r) => r.hash).join(","), "A,B");
  });

  it("A→B→A dedupes with no re-review of A", async () => {
    const { fake, sched, advance } = harness();
    sched.notify("A");
    await advance(10_000);
    assert.deepEqual(fake.reviews.map((r) => r.hash), ["A"]);
    sched.notify("B");
    await advance(10_000);
    assert.deepEqual(fake.reviews.map((r) => r.hash), ["A", "B"]);
    sched.notify("A"); // back to reviewed A
    assert.equal(sched.getState(), "IDLE");
    await advance(70_000);
    assert.deepEqual(fake.reviews.map((r) => r.hash), ["A", "B"]);
  });

  it("A reviewed → B in flight → A keeps REVIEWING, no concurrent review, no A re-fire", async () => {
    const { fake, sched, advance } = harness();
    sched.notify("A");
    await advance(10_000);
    let release!: (v: { ok: true }) => void;
    fake.reviewImpl = (_d, hash) =>
      new Promise((r) => {
        fake.reviews.push({ hash, ok: true });
        release = r as (v: { ok: true }) => void;
      });
    sched.notify("B");
    await advance(10_000);
    assert.equal(sched.getState(), "REVIEWING");
    sched.notify("A"); // back to reviewed while B in flight
    assert.equal(sched.getState(), "REVIEWING"); // must NOT drop to IDLE
    assert.equal(fake.reviews.length, 2); // A then B started
    release!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    // latestHash is A (≠ frozen B) so drain restarts debounce; gate then dedupes A → IDLE
    assert.equal(sched.getState(), "PENDING");
    await advance(10_000);
    assert.equal(sched.getState(), "IDLE");
    await advance(70_000);
    assert.deepEqual(fake.reviews.map((r) => r.hash), ["A", "B"]);
  });

  it("same + C before B completes drains C through gate", async () => {
    const { fake, sched, advance } = harness();
    sched.notify("A");
    await advance(10_000);
    let release!: (v: { ok: true }) => void;
    fake.reviewImpl = (_d, hash) =>
      new Promise((r) => {
        fake.reviews.push({ hash, ok: true });
        release = r as (v: { ok: true }) => void;
      });
    sched.notify("B");
    await advance(10_000);
    sched.notify("A");
    sched.notify("C");
    release!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sched.getState(), "PENDING");
    await advance(10_000);
    assert.ok(fake.reviews.map((r) => r.hash).includes("C"));
    assert.ok(!fake.reviews.slice(2).some((r) => r.hash === "A"));
  });

  it("failure with no intervening edits re-queues via failed disjunct", async () => {
    const { fake, sched, advance } = harness({ minLines: 50, intervalSeconds: 60, debounceSeconds: 10 });
    fake.reviewImpl = async (_d, hash) => {
      fake.reviews.push({ hash, ok: false });
      return { ok: false, error: "boom" };
    };
    sched.notify("A");
    await advance(10_000);
    assert.equal(fake.reviews.length, 1);
    assert.equal(sched.getState(), "PENDING"); // failed → restart debounce
    // Interval rate-limit: next fire waits.
    await advance(10_000);
    assert.equal(sched.getState(), "WAITING_INTERVAL");
    await advance(50_000);
    assert.equal(fake.reviews.length, 2);
  });

  it("failed B + revert to reviewed A settles with no fire", async () => {
    const { fake, sched, advance } = harness();
    sched.notify("A");
    await advance(10_000); // A ok
    fake.reviewImpl = async (_d, hash) => {
      fake.reviews.push({ hash, ok: false });
      return { ok: false, error: "boom" };
    };
    sched.notify("B");
    await advance(10_000);
    // After B fails, PENDING; revert to A before debounce fires.
    sched.notify("A");
    assert.equal(sched.getState(), "IDLE");
    await advance(70_000);
    assert.deepEqual(
      fake.reviews.map((r) => r.hash + ":" + r.ok),
      ["A:true", "B:false"],
    );
  });

  it("WAITING_INTERVAL + change to reviewed hash cancels timer → IDLE", async () => {
    const { fake, sched, advance } = harness({ minLines: 50, intervalSeconds: 60, debounceSeconds: 10 });
    sched.notify("A");
    await advance(10_000);
    // Force interval wait: set lastReviewStartedAt by reviewing A; then notify B quickly.
    sched.notify("B");
    await advance(10_000);
    assert.equal(sched.getState(), "WAITING_INTERVAL");
    sched.notify("A"); // reviewed
    assert.equal(sched.getState(), "IDLE");
    await advance(70_000);
    assert.equal(fake.reviews.filter((r) => r.hash === "A").length, 1);
  });

  it("agentActive parks through quiet gap with no review", async () => {
    const { fake, sched, advance } = harness();
    sched.setAgentActive(true);
    sched.notify("A");
    await advance(70_000);
    assert.equal(fake.reviews.length, 0);
    assert.equal(sched.getState(), "IDLE");
  });

  it("markReviewed mid-PENDING settles IDLE", async () => {
    const { sched, advance } = harness();
    sched.notify("A");
    assert.equal(sched.getState(), "PENDING");
    sched.markReviewed("A");
    assert.equal(sched.getState(), "IDLE");
    await advance(70_000);
    assert.ok(sched.getReviewed().has("A"));
  });

  it("review completion while parked schedules nothing", async () => {
    const { fake, sched, advance } = harness();
    let release!: (v: { ok: true } | { ok: false; error: string }) => void;
    fake.reviewImpl = (_d, hash) =>
      new Promise((r) => {
        fake.reviews.push({ hash, ok: true });
        release = r;
      });
    sched.notify("A");
    await advance(10_000);
    assert.equal(sched.getState(), "REVIEWING");
    sched.setAgentActive(true);
    sched.notify("B"); // ignored while parked
    release!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sched.getState(), "IDLE");
    await advance(70_000);
    assert.equal(fake.reviews.length, 1); // no B, no retry
  });

  it("failure while parked → mark → resume retires (equal and different turnHash)", async () => {
    for (const turnHash of ["A", "TURN"]) {
      const { fake, sched, advance } = harness();
      let release!: (v: { ok: false; error: string }) => void;
      fake.reviewImpl = (_d, hash) =>
        new Promise((r) => {
          fake.reviews.push({ hash, ok: false });
          release = r as (v: { ok: false; error: string }) => void;
        });
      sched.notify("A");
      await advance(10_000);
      sched.setAgentActive(true);
      release!({ ok: false, error: "net" });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(sched.getState(), "IDLE");
      sched.markReviewed(turnHash);
      sched.setAgentActive(false);
      await advance(70_000);
      assert.equal(fake.reviews.length, 1, `turnHash=${turnHash}`);
    }
  });

  it("completion AFTER resume drains once for post-turn state", async () => {
    const { fake, sched, advance } = harness();
    let release!: (v: { ok: true }) => void;
    fake.reviewImpl = (_d, hash) =>
      new Promise((r) => {
        fake.reviews.push({ hash, ok: true });
        release = r as (v: { ok: true }) => void;
      });
    sched.notify("A");
    await advance(10_000);
    sched.setAgentActive(true);
    sched.markReviewed("TURN");
    sched.setAgentActive(false); // still REVIEWING — resume does nothing
    assert.equal(sched.getState(), "REVIEWING");
    sched.notify("C"); // pending while still reviewing (unparked)
    release!({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sched.getState(), "PENDING");
    await advance(10_000);
    assert.ok(fake.reviews.map((r) => r.hash).includes("C"));
  });

  it("below min-lines stays IDLE", async () => {
    const { fake, sched, advance } = harness();
    fake.lines = 10;
    sched.notify("A");
    await advance(10_000);
    assert.equal(fake.reviews.length, 0);
    assert.equal(sched.getState(), "IDLE");
  });
});
