import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileState } from "../core/checkpoint.ts";
import { DEFAULTS } from "../core/config.ts";
import { FILE_POINTS } from "../core/load.ts";
import { createRuntime, type PearRuntime } from "../adapters/pi/runtime.ts";

type Harness = {
  rt: PearRuntime;
  setFiles: (files: Record<string, string> | null) => void;
};

/**
 * Defaults to the building phase: these tests are about the change gate, and
 * scoping blocks every mutation outright. Phase behaviour lives in phase.test.ts.
 */
function harness(
  overrides: { mode?: "off" | "agent-driver"; budget?: number; planPhase?: boolean } = {},
): Harness {
  let files: FileState | null = new Map();
  const rt = createRuntime({
    mode: overrides.mode ?? "agent-driver",
    reviewBudget: overrides.budget ?? DEFAULTS.reviewBudget,
    planPhase: overrides.planPhase ?? false,
    captureFiles: () => (files === null ? null : new Map(files)),
    now: () => 0,
  });
  return {
    rt,
    setFiles: (f) => {
      files = f === null ? null : new Map(Object.entries(f));
    },
  };
}

const body = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");

/** A write costing FILE_POINTS + `lines` the first time it touches `path`. */
const write = (rt: PearRuntime, id: string, path: string, lines = 0) =>
  rt.onMutatingToolCall("write", id, { path, content: body(lines) });

const bash = (rt: PearRuntime, id: string, command: string) =>
  rt.onMutatingToolCall("bash", id, { command });

/** Four 100-point writes fit under the default budget of 200; the fifth is refused. */
const HUNDRED = 100 - FILE_POINTS;

describe("the gate", () => {
  it("does nothing in off mode", () => {
    const { rt } = harness({ mode: "off" });
    for (let i = 0; i < 20; i++) assert.equal(write(rt, `c${i}`, `f${i}.ts`, 500), undefined);
  });

  it("admits while the accrued load is under the block threshold", () => {
    const { rt } = harness({ budget: 200 });
    // Loads before each call: 0, 100, 200, 300 — all below 2x budget.
    for (const [i, path] of ["a.ts", "b.ts", "c.ts", "d.ts"].entries()) {
      assert.equal(write(rt, `c${i}`, path, HUNDRED), undefined, path);
    }
    assert.equal(rt.checkpoint.snapshot().points, 400);

    const blocked = write(rt, "c4", "e.ts", HUNDRED);
    assert.ok(blocked?.block);
    assert.match(blocked.reason, /checkpoint overdue/);
    assert.match(blocked.reason, /NOT EXECUTED/);
  });

  it("is admit-first: an oversized change runs and the NEXT call is blocked", () => {
    // The whole point. Blocking a call on its own estimated cost would force a
    // checkpoint with nothing yet to review.
    const { rt } = harness({ budget: 200 });
    assert.equal(write(rt, "big", "big.ts", 400), undefined, "the big write itself runs");
    assert.equal(rt.checkpoint.snapshot().points, FILE_POINTS + 400);

    assert.ok(write(rt, "next", "small.ts", 1)?.block, "everything after it is blocked");
  });

  it("never blocks the first change in a window, even at the minimum budget", () => {
    const { rt } = harness({ budget: FILE_POINTS });
    assert.equal(write(rt, "a", "a.ts", 0), undefined);
  });

  it("does not count a blocked call against the load", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    const before = rt.checkpoint.snapshot().points;
    write(rt, "b", "b.ts", 10); // blocked
    write(rt, "c", "c.ts", 10); // blocked
    assert.equal(rt.checkpoint.snapshot().points, before);
  });

  it("frees load when a call fails", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    assert.ok(write(rt, "b", "b.ts", 10)?.block);

    rt.onToolResult("a", true); // errored
    assert.equal(write(rt, "c", "c.ts", 10), undefined, "load released by the failure");
  });

  it("charges repeated edits to one file only once for the file", () => {
    // v2 counted calls, so five small edits to one file tripped a budget of 5.
    const { rt } = harness({ budget: 200 });
    for (let i = 0; i < 5; i++) {
      assert.equal(write(rt, `c${i}`, "same.ts", 2), undefined, `edit ${i + 1}`);
    }
    assert.equal(rt.checkpoint.snapshot().points, FILE_POINTS + 10);
    assert.equal(rt.tier(), "quiet", "five small edits to one file is not a checkpoint");
  });

  it("blocks each concurrent sibling once the threshold is crossed", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    const points = rt.checkpoint.snapshot().points;
    // Siblings preflight sequentially; each independently sees a closed gate.
    for (const id of ["c", "d", "e"]) {
      assert.ok(write(rt, id, `${id}.ts`, 5)?.block, `${id} should be blocked`);
    }
    assert.equal(rt.checkpoint.snapshot().points, points);
  });

  it("reopens after a checkpoint is answered", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    assert.ok(write(rt, "b", "b.ts", 1)?.block);

    assert.ok("pending" in rt.beginCheckpoint());
    rt.applyCheckpointAnswer({ kind: "continue" });

    assert.equal(write(rt, "c", "c.ts", 1), undefined, "load reset by the checkpoint");
  });
});

describe("bash classification in the gate", () => {
  it("does not count read-only commands", () => {
    const { rt } = harness({ budget: FILE_POINTS });
    assert.equal(bash(rt, "a", "git status"), undefined);
    assert.equal(bash(rt, "b", "ls -la"), undefined);
    assert.equal(rt.checkpoint.snapshot().points, 0);
  });

  it("charges the opaque penalty for anything not provably read-only", () => {
    const { rt } = harness();
    bash(rt, "a", "rm -rf x");
    assert.equal(rt.checkpoint.snapshot().points, 60);
  });
});

describe("in-band budget nags", () => {
  const settle = (rt: PearRuntime, id: string) => rt.onToolResult(id, false);

  it("says nothing while the load is low", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 10);
    assert.equal(settle(rt, "a"), undefined);
  });

  it("mentions it in passing past the soft fraction", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 100); // 140 points
    assert.match(settle(rt, "a") ?? "", /look for a good place to check in/);
  });

  it("says plainly that a checkpoint is due at the budget", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 200); // 240 points
    assert.match(settle(rt, "a") ?? "", /before the next edit/);
  });

  it("still nags firmly past the block threshold", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    assert.match(settle(rt, "a") ?? "", /before the next edit/);
  });

  it("says nothing about a read-only or unadmitted call", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 200);
    settle(rt, "a");
    assert.equal(rt.onToolResult("never-admitted", false), undefined);
  });

  it("says nothing when a call failed, since its load was released", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    assert.equal(rt.onToolResult("a", true), undefined);
  });

  it("stays quiet while a card is open, which already says it", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    rt.beginCheckpoint();
    assert.equal(settle(rt, "a"), undefined);
  });

  it("stays quiet while stopped, which already says it", () => {
    const { rt } = harness({ budget: 200 });
    rt.beginCheckpoint();
    rt.applyCheckpointAnswer({ kind: "stop" });
    write(rt, "a", "a.ts", 400); // blocked, so never admitted
    assert.equal(settle(rt, "a"), undefined);
  });
});

describe("stop", () => {
  const stop = (rt: PearRuntime) => {
    rt.beginCheckpoint();
    return rt.applyCheckpointAnswer({ kind: "stop" });
  };

  it("blocks mutations but still allows inspection", () => {
    const { rt } = harness();
    stop(rt);

    assert.ok(write(rt, "a", "a.ts")?.block, "edits blocked");
    assert.match(write(rt, "b", "b.ts")?.reason ?? "", /asked you to stop/);
    assert.equal(bash(rt, "c", "git status"), undefined, "read-only bash still allowed");
  });

  it("asks the host to end the agent loop", () => {
    const { rt } = harness();
    assert.equal(stop(rt).terminate, true);
  });

  it("outranks the budget: the reason is stop, not overdue", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    stop(rt);
    assert.match(write(rt, "b", "b.ts")?.reason ?? "", /asked you to stop/);
  });

  it("is not cleared by the run boundary", () => {
    const { rt } = harness();
    stop(rt);
    rt.onAgentSettled();
    assert.ok(write(rt, "a", "a.ts")?.block, "still stopped after the run settles");
  });

  it("is cleared by genuine user input", () => {
    const { rt } = harness();
    stop(rt);
    rt.onUserInput();
    assert.equal(write(rt, "a", "a.ts"), undefined);
  });
});

describe("dismiss is a pause, not a stop", () => {
  const dismiss = (rt: PearRuntime) => {
    rt.beginCheckpoint();
    return rt.applyCheckpointAnswer({ kind: "dismissed" });
  };

  it("ends the turn without latching a stop", () => {
    const { rt } = harness();
    const res = dismiss(rt);
    assert.equal(res.terminate, true);
    assert.equal(rt.stopped, false, "no stop latch");
    assert.equal(rt.paused, true);
  });

  it("holds changes for the rest of the run", () => {
    const { rt } = harness();
    dismiss(rt);
    assert.match(write(rt, "a", "a.ts")?.reason ?? "", /stepped away/);
  });

  it("expires at the run boundary, unlike a stop", () => {
    const { rt } = harness();
    dismiss(rt);
    rt.onAgentSettled();
    assert.equal(rt.paused, false);
    assert.equal(write(rt, "a", "a.ts"), undefined, "the next run is free to work");
  });

  it("is cleared by genuine user input", () => {
    const { rt } = harness();
    dismiss(rt);
    rt.onUserInput();
    assert.equal(write(rt, "a", "a.ts"), undefined);
  });

  it("does NOT acknowledge the change set", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    dismiss(h.rt);
    assert.deepEqual(
      h.rt.filesSinceBaseline().files,
      ["a.ts"],
      "unreviewed files must still be shown next time",
    );
  });
});

describe("checkpoint answers", () => {
  it("continue acknowledges the current files", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    h.rt.beginCheckpoint();
    h.rt.applyCheckpointAnswer({ kind: "continue" });
    assert.deepEqual(h.rt.filesSinceBaseline().files, [], "acknowledged files are not re-listed");
  });

  it("steering acknowledges too, so corrections form the next delta", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    h.rt.beginCheckpoint();
    const res = h.rt.applyCheckpointAnswer({ kind: "steer", text: "use a map instead" });
    assert.match(res.text, /NAVIGATOR STEERING: use a map instead/);
    assert.equal(res.terminate, false);

    // Already-shown file is not repeated...
    assert.deepEqual(h.rt.filesSinceBaseline().files, []);
    // ...but the correction is.
    h.setFiles({ "a.ts": "h:2" });
    assert.deepEqual(h.rt.filesSinceBaseline().files, ["a.ts"]);
  });

  it("mode-off neither acknowledges nor stops", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    h.rt.beginCheckpoint();
    const res = h.rt.applyCheckpointAnswer({ kind: "mode-off" });

    assert.equal(res.terminate, false);
    assert.deepEqual(h.rt.filesSinceBaseline().files, ["a.ts"]);
  });

  it("no answer parks the agent: every one resolves without terminating on continue", () => {
    // Guards the invariant that no card answer leaves the tool open.
    const h = harness();
    for (const answer of [
      { kind: "continue" } as const,
      { kind: "explain", file: "a.ts" } as const,
      { kind: "steer", text: "x" } as const,
      { kind: "mode-off" } as const,
    ]) {
      h.rt.beginCheckpoint();
      const res = h.rt.applyCheckpointAnswer(answer);
      assert.ok(res.text.length > 0, `${answer.kind} must produce a result`);
      assert.equal(res.terminate, false, `${answer.kind} must not end the turn`);
      h.rt.onUserInput(); // clear the explain hold for the next iteration
    }
  });

  it("reports an unverified file list when git is unavailable", () => {
    const h = harness();
    h.setFiles(null);
    const { files, verified } = h.rt.filesSinceBaseline();
    assert.equal(verified, false);
    assert.deepEqual(files, []);
  });
});

describe("pending card state machine", () => {
  it("returns an immediate result in off mode", () => {
    const { rt } = harness({ mode: "off" });
    const started = rt.beginCheckpoint();
    assert.ok("immediate" in started);
    assert.match(started.immediate.text, /not in agent-driver/);
  });

  it("rejects a second card while one is open", () => {
    const { rt } = harness();
    assert.ok("pending" in rt.beginCheckpoint());

    const second = rt.beginCheckpoint();
    assert.ok("immediate" in second);
    assert.match(second.immediate.text, /already open/);
  });

  it("rejects a card of a different kind while one is open", () => {
    const { rt } = harness();
    assert.ok("pending" in rt.beginCheckpoint());
    const ask = rt.beginAsk();
    assert.ok("immediate" in ask);
    assert.match(ask.immediate.text, /already open/);
  });

  it("allows a new card once the first resolves", () => {
    const { rt } = harness();
    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);
    started.pending.settle({ kind: "continue" });
    assert.ok("pending" in rt.beginCheckpoint());
  });

  it("resolves the promise exactly once, first answer wins", async () => {
    const { rt } = harness();
    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);

    started.pending.settle({ kind: "continue" });
    started.pending.settle({ kind: "stop" }); // must be a no-op
    rt.resolvePending({ kind: "dismissed" }); // must be a no-op
    assert.deepEqual(await started.pending.promise, { kind: "continue" });
  });

  it("a teardown beats a later settle from the card", async () => {
    const { rt } = harness();
    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);

    rt.resolvePending({ kind: "dismissed" });
    started.pending.settle({ kind: "continue" });
    assert.deepEqual(await started.pending.promise, { kind: "dismissed" });
  });

  it("a straggler from a closed card cannot close the card after it", async () => {
    const { rt } = harness();
    const first = rt.beginCheckpoint();
    assert.ok("pending" in first);
    first.pending.settle({ kind: "continue" });

    const second = rt.beginCheckpoint();
    assert.ok("pending" in second);
    first.pending.settle({ kind: "stop" }); // stale; must not touch the new card
    assert.equal(rt.isCardPending(), true, "the second card is still open");

    second.pending.settle({ kind: "continue" });
    assert.deepEqual(await second.pending.promise, { kind: "continue" });
  });

  it("resolving when nothing is pending is harmless", () => {
    const { rt } = harness();
    assert.doesNotThrow(() => rt.resolvePending({ kind: "dismissed" }));
  });
});

describe("mode switching", () => {
  it("off -> agent-driver starts from a clean budget", () => {
    const { rt } = harness({ mode: "off" });
    rt.setMode("agent-driver");
    assert.equal(rt.checkpoint.snapshot().points, 0);
    assert.equal(write(rt, "a", "a.ts"), undefined);
  });

  it("agent-driver -> off clears state and stops gating", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    assert.ok(write(rt, "b", "b.ts")?.block);

    rt.setMode("off");
    assert.equal(rt.checkpoint.snapshot().points, 0);
    for (let i = 0; i < 10; i++) assert.equal(write(rt, `x${i}`, `x${i}.ts`, 500), undefined);
  });

  it("switching off resolves an open card as mode-off", async () => {
    const { rt } = harness();
    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);

    rt.setMode("off");
    assert.deepEqual(await started.pending.promise, { kind: "mode-off" });
    assert.equal(rt.isCardPending(), false);
  });

  it("switching clears every hold", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.applyCheckpointAnswer({ kind: "stop" });
    rt.setMode("off");
    rt.setMode("agent-driver");
    assert.equal(rt.stopped, false);
    assert.equal(write(rt, "a", "a.ts"), undefined);
  });

  it("re-applying the same mode is a no-op", () => {
    const { rt } = harness();
    write(rt, "a", "a.ts", 10);
    const points = rt.checkpoint.snapshot().points;
    rt.setMode("agent-driver");
    assert.equal(rt.checkpoint.snapshot().points, points, "load must not silently reset");
  });
});

describe("run boundaries", () => {
  it("sweeps orphaned calls to a counted-but-unknown state", () => {
    const { rt } = harness();
    write(rt, "aborted", "a.ts", 10);
    const report = rt.onAgentSettled();

    assert.equal(report.points, FILE_POINTS + 10);
    assert.equal(report.awaitingExplanation, null);
    assert.equal(rt.checkpoint.snapshot().stale, 1);
  });

  it("never blocks at a run boundary", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    assert.doesNotThrow(() => rt.onAgentSettled());
  });

  it("an overdue budget is recoverable without the model's cooperation", () => {
    // The human can always open a checkpoint themselves.
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 400);
    assert.ok(write(rt, "b", "b.ts")?.block);

    const started = rt.beginCheckpoint();
    assert.ok("pending" in started, "opening a checkpoint is never gated");
    rt.applyCheckpointAnswer({ kind: "continue" });
    assert.equal(write(rt, "c", "c.ts"), undefined);
  });
});

describe("status text", () => {
  it("shows the load in agent-driver mode", () => {
    const { rt } = harness({ budget: 200 });
    write(rt, "a", "a.ts", 10);
    assert.match(rt.statusText(), /driver 50\/200/);
  });

  it("shows stopped and awaiting states", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    assert.match(rt.statusText(), /awaiting you/);
    rt.applyCheckpointAnswer({ kind: "stop" });
    assert.match(rt.statusText(), /stopped/);
  });

  it("shows a paused state", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.applyCheckpointAnswer({ kind: "dismissed" });
    assert.match(rt.statusText(), /paused/);
  });

  it("shows the file being reviewed", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.applyCheckpointAnswer({ kind: "explain", file: "src/a.ts" });
    assert.match(rt.statusText(), /reviewing src\/a\.ts/);
  });

  it("shows only the mode when off", () => {
    const { rt } = harness({ mode: "off" });
    assert.equal(rt.statusText(), "pear: off");
  });
});
