import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCheckpoint,
  diffFileState,
  isUncertain,
  type FileState,
} from "../core/checkpoint.ts";
import { FILE_POINTS, OPAQUE_POINTS, type ChangeCost } from "../core/load.ts";

const state = (entries: Record<string, string>): FileState => new Map(Object.entries(entries));

/** A readable change to one file. */
const cost = (path: string, lines = 0): ChangeCost => ({ paths: [path], lines, opaque: false });
/** An unmeasurable change, as a mutating bash call produces. */
const opaque: ChangeCost = { paths: [], lines: 0, opaque: true };

/** The call-count buckets, which several tests assert on together. */
function buckets(cp: ReturnType<typeof createCheckpoint>) {
  const { confirmed, pending, stale, calls } = cp.snapshot();
  return { confirmed, pending, stale, calls };
}

describe("checkpoint accounting: buckets", () => {
  it("counts an admitted call before it settles", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts"), 0);
    assert.deepEqual(buckets(cp), { confirmed: 0, pending: 1, stale: 0, calls: 1 });
  });

  it("confirms a successful call", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts"), 0);
    assert.equal(cp.settle("a", true), "confirmed");
    assert.deepEqual(buckets(cp), { confirmed: 1, pending: 0, stale: 0, calls: 1 });
  });

  it("frees the budget when a call fails", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts", 30), 0);
    assert.equal(cp.settle("a", false), "failed");
    assert.deepEqual(buckets(cp), { confirmed: 0, pending: 0, stale: 0, calls: 0 });
    assert.equal(cp.snapshot().points, 0, "a failed call must cost nothing");
  });

  it("settles each entry exactly once", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts"), 0);
    assert.equal(cp.settle("a", true), "confirmed");
    assert.equal(cp.settle("a", true), undefined, "second settle must be a no-op");
    assert.equal(cp.snapshot().confirmed, 1);
  });

  it("ignores results for calls that were never admitted", () => {
    const cp = createCheckpoint();
    assert.equal(cp.settle("never-seen", true), undefined);
    assert.equal(cp.settle("pear_checkpoint-call", false), undefined);
    assert.deepEqual(buckets(cp), { confirmed: 0, pending: 0, stale: 0, calls: 0 });
  });

  it("fails closed when a live call id is reused", () => {
    const cp = createCheckpoint();
    cp.admit("dup", "edit", cost("a.ts"), 0);
    cp.admit("dup", "write", cost("b.ts"), 1);
    // The first call's cost is retained rather than lost.
    assert.deepEqual(buckets(cp), { confirmed: 1, pending: 1, stale: 0, calls: 2 });
    assert.equal(cp.snapshot().points, 2 * FILE_POINTS, "both files still counted");

    // The surviving entry is the newer one and settles normally.
    assert.equal(cp.settle("dup", true), "confirmed");
    assert.deepEqual(buckets(cp), { confirmed: 2, pending: 0, stale: 0, calls: 2 });
  });

  it("sweeps unsettled calls to stale, never to confirmed", () => {
    const cp = createCheckpoint();
    cp.admit("aborted", "bash", opaque, 0);
    assert.equal(cp.sweepStale(), 1);

    assert.deepEqual(buckets(cp), { confirmed: 0, pending: 0, stale: 1, calls: 1 });
    // A call that never reported back still costs, so the human looks early.
    assert.equal(cp.snapshot().points, OPAQUE_POINTS);
  });

  it("sweeping is a no-op when nothing is pending", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts"), 0);
    cp.settle("a", true);
    assert.equal(cp.sweepStale(), 0);
    assert.equal(cp.snapshot().stale, 0);
  });

  it("does not re-sweep an already-stale call", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts"), 0);
    assert.equal(cp.sweepStale(), 1);
    assert.equal(cp.sweepStale(), 0, "already stale");
    assert.equal(cp.snapshot().stale, 1);
  });

  it("ignores a late settle that arrives after a reset", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts"), 0);
    cp.reset(new Map());
    assert.equal(cp.settle("a", true), undefined);
    assert.deepEqual(buckets(cp), { confirmed: 0, pending: 0, stale: 0, calls: 0 });
  });

  it("ignores a late settle for a call that was swept stale", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts"), 0);
    cp.sweepStale();
    assert.equal(cp.settle("a", true), undefined, "stale is terminal");
    assert.equal(cp.snapshot().stale, 1);
  });

  it("reset clears every bucket", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts", 5), 0);
    cp.settle("a", true);
    cp.admit("b", "edit", cost("b.ts", 5), 1);
    cp.sweepStale();
    cp.admit("c", "edit", cost("c.ts", 5), 2);

    cp.reset(new Map());
    assert.deepEqual(buckets(cp), { confirmed: 0, pending: 0, stale: 0, calls: 0 });
    assert.equal(cp.snapshot().points, 0);
  });
});

describe("checkpoint accounting: review load", () => {
  it("charges a file once no matter how many calls touch it", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("same.ts", 3), 0);
    cp.admit("b", "edit", cost("same.ts", 4), 1);
    cp.admit("c", "edit", cost("same.ts", 5), 2);

    const snap = cp.snapshot();
    assert.equal(snap.files, 1);
    assert.equal(snap.lines, 12);
    assert.equal(snap.points, FILE_POINTS + 12);
  });

  it("charges each distinct file", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts", 10), 0);
    cp.admit("b", "write", cost("b.ts", 20), 1);

    const snap = cp.snapshot();
    assert.equal(snap.files, 2);
    assert.equal(snap.points, 2 * FILE_POINTS + 30);
  });

  it("releases a file charge when the only call that touched it fails", () => {
    // This is the case a running counter gets wrong: without recomputing, the
    // file charge from the failed call would linger and trip the budget early.
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("a.ts", 10), 0);
    cp.admit("b", "edit", cost("b.ts", 10), 1);
    cp.settle("b", false);

    const snap = cp.snapshot();
    assert.equal(snap.files, 1);
    assert.equal(snap.points, FILE_POINTS + 10);
  });

  it("keeps a file charge when another surviving call still touches it", () => {
    const cp = createCheckpoint();
    cp.admit("a", "edit", cost("shared.ts", 10), 0);
    cp.admit("b", "edit", cost("shared.ts", 10), 1);
    cp.settle("a", false);

    const snap = cp.snapshot();
    assert.equal(snap.files, 1, "still touched by b");
    assert.equal(snap.points, FILE_POINTS + 10);
  });

  it("is independent of admission and settle order", () => {
    const build = (order: string[]) => {
      const cp = createCheckpoint();
      const costs: Record<string, ChangeCost> = {
        a: cost("a.ts", 7),
        b: cost("b.ts", 11),
        c: cost("a.ts", 13),
      };
      order.forEach((id, i) => cp.admit(id, "edit", costs[id], i));
      return cp.snapshot().points;
    };
    assert.equal(build(["a", "b", "c"]), build(["c", "b", "a"]));
    assert.equal(build(["a", "b", "c"]), 2 * FILE_POINTS + 31);
  });

  it("charges the opaque penalty per unmeasurable call, naming no file", () => {
    const cp = createCheckpoint();
    cp.admit("a", "bash", opaque, 0);
    cp.admit("b", "bash", opaque, 1);

    const snap = cp.snapshot();
    assert.equal(snap.files, 0);
    assert.equal(snap.points, 2 * OPAQUE_POINTS);
  });

  it("adds the opaque penalty on top of a measurable cost", () => {
    const cp = createCheckpoint();
    cp.admit("a", "write", { paths: ["a.ts"], lines: 0, opaque: true }, 0);
    assert.equal(cp.snapshot().points, FILE_POINTS + OPAQUE_POINTS);
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
