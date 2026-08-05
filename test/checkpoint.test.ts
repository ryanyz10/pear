import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACK_CONTRACT,
  STEERING_CONTRACT,
  buildSummary,
  createCheckpoint,
  filesSincePersistedBaseline,
} from "../core/checkpoint.ts";

const cfg = { checkpointSeconds: 300, maxChangesPerCheckpoint: 5 };

describe("checkpoint contracts", () => {
  it("exports the steering and ack contract strings", () => {
    assert.equal(STEERING_CONTRACT, "NOT EXECUTED — human steering: ");
    assert.match(ACK_CONTRACT, /^NOT EXECUTED — checkpoint acknowledged/);
  });
});

describe("buildSummary", () => {
  it("matches pear's gate summary format", () => {
    const s = buildSummary("write a.ts", { elapsedMs: 252_000, changes: 2 }, ["a.ts", "b.ts"]);
    assert.match(s, /── checkpoint ──/);
    assert.match(s, /4m12s elapsed \/ 2 changes/);
    assert.match(s, /files:\n- a\.ts\n- b\.ts/);
    assert.match(s, /about to: write a\.ts/);
    assert.match(s, /Enter = continue/);
    assert.match(
      s,
      /Before continuing: tell the human the big-picture goal of this batch and what you plan to do next, then continue\./,
    );
  });

  it("formats sub-minute elapsed time without a minutes component", () => {
    const s = buildSummary("bash ls", { elapsedMs: 9_000, changes: 1 }, []);
    assert.match(s, /9s elapsed \/ 1 changes/);
  });
});

describe("createCheckpoint", () => {
  it("trips when maxChangesPerCheckpoint reservations are pending under sequential reserve/settle", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    for (let i = 0; i < 5; i++) {
      assert.equal(cp.check(0), false, `call ${i} should be under`);
      cp.reserve(`c${i}`);
      cp.settle(`c${i}`, true);
    }
    assert.equal(cp.check(0), true, "6th call trips (maxChangesPerCheckpoint=5)");
  });

  it("trips when maxChangesPerCheckpoint reservations are pending via concurrent preflight", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    for (let i = 0; i < 5; i++) {
      assert.equal(cp.check(0), false);
      cp.reserve(`c${i}`);
    }
    assert.equal(cp.check(0), true, "6th preflight trips while 5 pending");
    // settle with one failure — releases reservation
    for (let i = 0; i < 4; i++) cp.settle(`c${i}`, true);
    cp.settle("c4", false);
    assert.equal(cp.snapshot().confirmed, 4);
    assert.equal(cp.snapshot().pending, 0);
  });

  it("two full checkpoint cycles both trip on N+1", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    for (let i = 0; i < 5; i++) {
      cp.reserve(`a${i}`);
      cp.settle(`a${i}`, true);
    }
    assert.equal(cp.check(0), true);
    cp.resetBaseline(0, new Map());
    for (let i = 0; i < 5; i++) {
      assert.equal(cp.check(0), false);
      cp.reserve(`b${i}`);
      cp.settle(`b${i}`, true);
    }
    assert.equal(cp.check(0), true);
  });

  it("resetBaseline forgives in-flight reservations", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    cp.reserve("x");
    cp.reserve("y");
    assert.equal(cp.snapshot().pending, 2);
    cp.resetBaseline(10, new Map());
    assert.equal(cp.snapshot().pending, 0);
    assert.equal(cp.snapshot().confirmed, 0);
    assert.equal(cp.getBaselineTime(), 10);
    cp.settle("x", true); // no-op
    cp.settle("y", false); // no-op
    assert.equal(cp.snapshot().confirmed, 0);
    assert.equal(cp.snapshot().pending, 0);
  });

  it("settle is idempotent for unknown ids", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    cp.settle("ghost", true);
    cp.settle("ghost", true);
    assert.equal(cp.snapshot().confirmed, 0);
  });

  it("trips when checkpointSeconds elapses with zero changes", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    assert.equal(cp.check(299_000), false);
    assert.equal(cp.check(300_000), true);
  });

  it("OR semantics: either elapsed-over or changes-over trips independently", () => {
    const local = { checkpointSeconds: 300, maxChangesPerCheckpoint: 3 };
    const cp = createCheckpoint(local, 0, new Map());
    assert.equal(cp.check(299_000), false, "under both");
    cp.reserve("a");
    cp.reserve("b");
    assert.equal(cp.check(0), false, "2 pending, under maxChangesPerCheckpoint=3");
    cp.reserve("c");
    assert.equal(cp.check(0), true, "3 pending >= maxChangesPerCheckpoint=3");
  });
});

describe("filesSincePersistedBaseline", () => {
  it("returns paths missing from or differing against the baseline", () => {
    const baseline = { "a.ts": "h1", "b.ts": "h2" };
    const current = { "a.ts": "h1", "b.ts": "h2-changed", "c.ts": "h3" };
    assert.deepEqual(filesSincePersistedBaseline(baseline, current).sort(), ["b.ts", "c.ts"]);
  });
});

describe("Checkpoint.filesSinceBaseline", () => {
  it("excludes a file already dirty when the checkpoint is constructed", () => {
    const initial = new Map([["a.ts", "h1"]]);
    const cp = createCheckpoint(cfg, 0, initial);
    const stillDirty = new Map([["a.ts", "h1"]]);
    assert.deepEqual(cp.filesSinceBaseline(stillDirty), []);
  });

  it("only lists newly-touched files after a reset, not files already shown", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    const afterBatch1 = new Map([
      ["a.ts", "h1"],
      ["b.ts", "h2"],
    ]);
    assert.deepEqual(cp.filesSinceBaseline(afterBatch1).sort(), ["a.ts", "b.ts"]);
    cp.resetBaseline(100, afterBatch1);
    const afterBatch2 = new Map([
      ["a.ts", "h1"],
      ["b.ts", "h2"],
      ["c.ts", "h3"],
    ]);
    assert.deepEqual(cp.filesSinceBaseline(afterBatch2), ["c.ts"]);
  });

  it("a file edited again after checkpoint 1 reappears in checkpoint 2", () => {
    const cp = createCheckpoint(cfg, 0, new Map());
    const afterBatch1 = new Map([["a.ts", "h1"]]);
    assert.deepEqual(cp.filesSinceBaseline(afterBatch1), ["a.ts"]);
    cp.resetBaseline(100, afterBatch1);
    const afterBatch2 = new Map([["a.ts", "h2"]]); // edited again, hash changed
    assert.deepEqual(cp.filesSinceBaseline(afterBatch2), ["a.ts"]);
  });
});
