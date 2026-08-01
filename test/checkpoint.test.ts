import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_CONTRACT,
  STEERING_CONTRACT,
  buildSummary,
  createCheckpoint,
} from "../core/checkpoint.ts";

const cfg = { pauseLines: 150, pauseEdits: 5 };

describe("checkpoint contracts", () => {
  it("exports the steering and ack contract strings", () => {
    assert.equal(STEERING_CONTRACT, "NOT EXECUTED — human steering: ");
    assert.match(ACK_CONTRACT, /^NOT EXECUTED — checkpoint acknowledged/);
  });
});

describe("buildSummary", () => {
  it("matches pear's gate summary format", () => {
    const s = buildSummary("write a.ts", { lines: 10, mutations: 2 }, ["a.ts", "b.ts"]);
    assert.match(s, /── checkpoint ──/);
    assert.match(s, /\+10 lines \/ 2 mutations/);
    assert.match(s, /files: a\.ts, b\.ts/);
    assert.match(s, /about to: write a\.ts/);
    assert.match(s, /Enter = continue/);
  });
});

describe("createCheckpoint", () => {
  it("trips on the (N+1)th mutation under sequential reserve/settle", () => {
    const cp = createCheckpoint(cfg, 0);
    for (let i = 0; i < 5; i++) {
      assert.equal(cp.check({ lines: 0 }), false, `call ${i} should be under`);
      cp.reserve(`c${i}`);
      cp.settle(`c${i}`, true);
    }
    assert.equal(cp.check({ lines: 0 }), true, "6th call trips (pauseEdits=5)");
  });

  it("trips on the (N+1)th concurrent preflight via reservations", () => {
    const cp = createCheckpoint(cfg, 0);
    for (let i = 0; i < 5; i++) {
      assert.equal(cp.check({ lines: 0 }), false);
      cp.reserve(`c${i}`);
    }
    assert.equal(cp.check({ lines: 0 }), true, "6th preflight trips while 5 pending");
    // settle with one failure — releases reservation
    for (let i = 0; i < 4; i++) cp.settle(`c${i}`, true);
    cp.settle("c4", false);
    assert.equal(cp.snapshot().confirmed, 4);
    assert.equal(cp.snapshot().pending, 0);
  });

  it("two full checkpoint cycles both trip on N+1", () => {
    const cp = createCheckpoint(cfg, 0);
    for (let i = 0; i < 5; i++) {
      cp.reserve(`a${i}`);
      cp.settle(`a${i}`, true);
    }
    assert.equal(cp.check({ lines: 0 }), true);
    cp.resetBaseline(0);
    for (let i = 0; i < 5; i++) {
      assert.equal(cp.check({ lines: 0 }), false);
      cp.reserve(`b${i}`);
      cp.settle(`b${i}`, true);
    }
    assert.equal(cp.check({ lines: 0 }), true);
  });

  it("resetBaseline forgives in-flight reservations", () => {
    const cp = createCheckpoint(cfg, 0);
    cp.reserve("x");
    cp.reserve("y");
    assert.equal(cp.snapshot().pending, 2);
    cp.resetBaseline(10);
    assert.equal(cp.snapshot().pending, 0);
    assert.equal(cp.snapshot().confirmed, 0);
    assert.equal(cp.getBaselineLines(), 10);
    cp.settle("x", true); // no-op
    cp.settle("y", false); // no-op
    assert.equal(cp.snapshot().confirmed, 0);
    assert.equal(cp.snapshot().pending, 0);
  });

  it("settle is idempotent for unknown ids", () => {
    const cp = createCheckpoint(cfg, 0);
    cp.settle("ghost", true);
    cp.settle("ghost", true);
    assert.equal(cp.snapshot().confirmed, 0);
  });

  it("deferred rebase blinds lines until finishRebase", () => {
    const cp = createCheckpoint(cfg, 0);
    cp.reserve("a");
    cp.resetBaseline(null); // mid-batch
    assert.equal(cp.snapshot().rebasePending, true);
    assert.equal(cp.snapshot().pending, 0);
    // late sibling write bumps lines to 200 — must NOT trip while rebasing
    assert.equal(cp.check({ lines: 200 }), false);
    cp.finishRebase(200);
    assert.equal(cp.snapshot().rebasePending, false);
    assert.equal(cp.getBaselineLines(), 200);
    // next-turn over-budget write charges on its own lines
    assert.equal(cp.check({ lines: 400 }), true); // +200 >= 150
  });

  it("abandonRebase keeps old baseline", () => {
    const cp = createCheckpoint(cfg, 50);
    cp.resetBaseline(null);
    cp.abandonRebase();
    assert.equal(cp.snapshot().rebasePending, false);
    assert.equal(cp.getBaselineLines(), 50);
    assert.equal(cp.check({ lines: 220 }), true); // over-charges from old baseline
  });

  it("finishRebase is no-op when not pending", () => {
    const cp = createCheckpoint(cfg, 10);
    cp.finishRebase(999);
    assert.equal(cp.getBaselineLines(), 10);
  });

  it("non-git mutation-only pacing works with lines fixed at 0", () => {
    const cp = createCheckpoint(cfg, 0);
    for (let i = 0; i < 5; i++) {
      cp.reserve(`m${i}`);
      cp.settle(`m${i}`, true);
    }
    assert.equal(cp.check({ lines: 0 }), true);
  });

  it("trips on lines alone", () => {
    const cp = createCheckpoint(cfg, 0);
    assert.equal(cp.check({ lines: 150 }), true);
  });
});
