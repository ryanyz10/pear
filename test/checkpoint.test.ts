import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCheckpoint,
  diffFileState,
  isUncertain,
  type FileState,
} from "../core/checkpoint.ts";

const state = (entries: Record<string, string>): FileState => new Map(Object.entries(entries));

describe("checkpoint accounting", () => {
  it("counts an admitted call before it settles", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", 0);
    assert.deepEqual(cp.snapshot(), { confirmed: 0, pending: 1, stale: 0, total: 1 });
  });

  it("confirms a successful call", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", 0);
    assert.equal(cp.settle("a", true), "confirmed");
    assert.deepEqual(cp.snapshot(), { confirmed: 1, pending: 0, stale: 0, total: 1 });
  });

  it("frees the budget when a call fails", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", 0);
    assert.equal(cp.settle("a", false), "failed");
    assert.deepEqual(cp.snapshot(), { confirmed: 0, pending: 0, stale: 0, total: 0 });
  });

  it("settles each entry exactly once", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", 0);
    assert.equal(cp.settle("a", true), "confirmed");
    assert.equal(cp.settle("a", true), undefined, "second settle must be a no-op");
    assert.equal(cp.snapshot().confirmed, 1);
  });

  it("ignores results for calls that were never admitted", () => {
    const cp = createCheckpoint();
    assert.equal(cp.settle("never-seen", true), undefined);
    assert.equal(cp.settle("pear_checkpoint-call", false), undefined);
    assert.deepEqual(cp.snapshot(), { confirmed: 0, pending: 0, stale: 0, total: 0 });
  });

  it("fails closed when a live call id is reused", () => {
    const cp = createCheckpoint();
    cp.admit("dup", "edit", 0);
    cp.admit("dup", "write", 1);
    // The first call's cost is retained rather than lost.
    assert.deepEqual(cp.snapshot(), { confirmed: 1, pending: 1, stale: 0, total: 2 });

    // The surviving entry is the newer one and settles normally.
    assert.equal(cp.settle("dup", true), "confirmed");
    assert.deepEqual(cp.snapshot(), { confirmed: 2, pending: 0, stale: 0, total: 2 });
  });

  it("sweeps unsettled calls to stale, never to confirmed", () => {
    const cp = createCheckpoint();
    cp.admit("aborted", "bash", 0);
    assert.equal(cp.sweepStale(), 1);

    const snap = cp.snapshot();
    assert.deepEqual(snap, { confirmed: 0, pending: 0, stale: 1, total: 1 });
    // still counts toward the gate
    assert.equal(snap.total, 1);
  });

  it("sweeping is a no-op when nothing is pending", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", 0);
    cp.settle("a", true);
    assert.equal(cp.sweepStale(), 0);
    assert.equal(cp.snapshot().stale, 0);
  });

  it("ignores a late settle that arrives after a reset", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", 0);
    cp.reset(new Map());
    assert.equal(cp.settle("a", true), undefined);
    assert.deepEqual(cp.snapshot(), { confirmed: 0, pending: 0, stale: 0, total: 0 });
  });

  it("reset clears every bucket", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", 0);
    cp.settle("a", true);
    cp.admit("b", "edit", 1);
    cp.sweepStale();
    cp.admit("c", "edit", 2);

    cp.reset(new Map());
    assert.deepEqual(cp.snapshot(), { confirmed: 0, pending: 0, stale: 0, total: 0 });
  });
});

describe("file state provenance", () => {
  it("reports added, modified, and removed paths", () => {
    const before = state({ keep: "h:1", change: "h:1", gone: "h:1" });
    const after = state({ keep: "h:1", change: "h:2", added: "h:9" });
    assert.deepEqual(diffFileState(before, after), ["added", "change", "gone"]);
  });

  it("does not re-list a file the human already acknowledged", () => {
    const cp = createCheckpoint(state({ a: "h:1" }));
    // a changed and was acknowledged
    cp.reset(state({ a: "h:2" }));
    assert.deepEqual(cp.filesSinceBaseline(state({ a: "h:2" })), []);
  });

  it("re-lists a file that changed again after acknowledgement", () => {
    const cp = createCheckpoint(state({ a: "h:1" }));
    cp.reset(state({ a: "h:2" }));
    assert.deepEqual(cp.filesSinceBaseline(state({ a: "h:3" })), ["a"]);
  });

  it("treats unreadable files as changed even when the token is identical", () => {
    const token = "unreadable:EACCES";
    assert.equal(isUncertain(token), true);
    assert.deepEqual(diffFileState(state({ f: token }), state({ f: token })), ["f"]);
  });

  it("treats a file that became unreadable as changed", () => {
    assert.deepEqual(
      diffFileState(state({ f: "h:1" }), state({ f: "unreadable:EACCES" })),
      ["f"],
    );
  });
});
