import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileState } from "../core/checkpoint.ts";
import { createRuntime, type PearRuntime } from "../adapters/pi/runtime.ts";

type Harness = {
  rt: PearRuntime;
  setFiles: (files: Record<string, string> | null) => void;
};

function harness(overrides: { mode?: "off" | "agent-driver"; max?: number } = {}): Harness {
  let files: FileState | null = new Map();
  const rt = createRuntime({
    cwd: "/tmp/not-used",
    mode: overrides.mode ?? "agent-driver",
    maxChangesPerCheckpoint: overrides.max ?? 5,
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

const edit = (rt: PearRuntime, id: string) => rt.onMutatingToolCall("edit", id, { path: "f.ts" });
const bash = (rt: PearRuntime, id: string, command: string) =>
  rt.onMutatingToolCall("bash", id, { command });

describe("the gate", () => {
  it("does nothing in off mode", () => {
    const { rt } = harness({ mode: "off" });
    for (let i = 0; i < 20; i++) assert.equal(edit(rt, `c${i}`), undefined);
  });

  it("admits exactly max calls and blocks the next", () => {
    const { rt } = harness({ max: 5 });
    for (let i = 0; i < 5; i++) assert.equal(edit(rt, `c${i}`), undefined, `call ${i + 1}`);

    const blocked = edit(rt, "c5");
    assert.ok(blocked?.block);
    assert.match(blocked.reason, /checkpoint overdue/);
    assert.match(blocked.reason, /NOT EXECUTED/);
  });

  it("blocks the second call when max is 1", () => {
    const { rt } = harness({ max: 1 });
    assert.equal(edit(rt, "a"), undefined);
    assert.ok(edit(rt, "b")?.block);
  });

  it("does not count a blocked call against the budget", () => {
    const { rt } = harness({ max: 1 });
    edit(rt, "a");
    edit(rt, "b"); // blocked
    edit(rt, "c"); // blocked
    assert.equal(rt.checkpoint.snapshot().total, 1);
  });

  it("frees budget when a call fails", () => {
    const { rt } = harness({ max: 2 });
    edit(rt, "a");
    edit(rt, "b");
    assert.ok(edit(rt, "c")?.block);

    rt.onToolResult("b", true); // errored
    assert.equal(edit(rt, "d"), undefined, "budget freed by the failure");
  });

  it("blocks each concurrent sibling once the gate closes", () => {
    const { rt } = harness({ max: 2 });
    edit(rt, "a");
    edit(rt, "b");
    // Siblings preflight sequentially; each independently sees a closed gate.
    for (const id of ["c", "d", "e"]) {
      const decision = edit(rt, id);
      assert.ok(decision?.block, `${id} should be blocked`);
    }
    assert.equal(rt.checkpoint.snapshot().total, 2);
  });

  it("reopens after a checkpoint is answered", () => {
    const { rt } = harness({ max: 1 });
    edit(rt, "a");
    assert.ok(edit(rt, "b")?.block);

    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);
    rt.applyOutcome({ kind: "continue" });

    assert.equal(edit(rt, "c"), undefined, "budget reset by the checkpoint");
  });
});

describe("bash classification in the gate", () => {
  it("does not count read-only commands", () => {
    const { rt } = harness({ max: 1 });
    assert.equal(bash(rt, "a", "git status"), undefined);
    assert.equal(bash(rt, "b", "ls -la"), undefined);
    assert.equal(rt.checkpoint.snapshot().total, 0);
  });

  it("counts anything not provably read-only", () => {
    const { rt } = harness({ max: 5 });
    bash(rt, "a", "rm -rf x");
    assert.equal(rt.checkpoint.snapshot().total, 1);
  });
});

describe("stop", () => {
  it("blocks mutations but still allows inspection", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.applyOutcome({ kind: "stop" });

    assert.ok(edit(rt, "a")?.block, "edits blocked");
    assert.match(edit(rt, "b")?.reason ?? "", /asked you to stop/);
    assert.equal(bash(rt, "c", "git status"), undefined, "read-only bash still allowed");
  });

  it("asks the host to end the agent loop", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    assert.equal(rt.applyOutcome({ kind: "stop" }).terminate, true);
  });

  it("is not cleared by agent lifecycle events", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.applyOutcome({ kind: "stop" });

    rt.onAgentSettled();
    assert.ok(edit(rt, "a")?.block, "still stopped after the run settles");
  });

  it("is cleared by genuine user input", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.applyOutcome({ kind: "stop" });
    rt.onUserInput();
    assert.equal(edit(rt, "a"), undefined);
  });
});

describe("checkpoint outcomes", () => {
  it("continue acknowledges the current files", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    h.rt.beginCheckpoint();
    h.rt.applyOutcome({ kind: "continue" });
    assert.deepEqual(h.rt.filesSinceBaseline().files, [], "acknowledged files are not re-listed");
  });

  it("steering acknowledges too, so corrections form the next delta", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    h.rt.beginCheckpoint();
    const res = h.rt.applyOutcome({ kind: "steer", text: "use a map instead" });
    assert.match(res.text, /NAVIGATOR STEERING: use a map instead/);
    assert.equal(res.terminate, false);

    // Already-shown file is not repeated...
    assert.deepEqual(h.rt.filesSinceBaseline().files, []);
    // ...but the correction is.
    h.setFiles({ "a.ts": "h:2" });
    assert.deepEqual(h.rt.filesSinceBaseline().files, ["a.ts"]);
  });

  it("cancelling does NOT acknowledge, and pauses changes", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    h.rt.beginCheckpoint();
    const res = h.rt.applyOutcome({ kind: "cancelled" });

    assert.deepEqual(
      h.rt.filesSinceBaseline().files,
      ["a.ts"],
      "unreviewed files must still be shown next time",
    );
    assert.equal(res.terminate, true);
    assert.ok(edit(h.rt, "x")?.block, "changes paused until the human speaks");
  });

  it("mode-off neither acknowledges nor stops", () => {
    const h = harness();
    h.setFiles({ "a.ts": "h:1" });
    h.rt.beginCheckpoint();
    const res = h.rt.applyOutcome({ kind: "mode-off" });

    assert.equal(res.terminate, false);
    assert.deepEqual(h.rt.filesSinceBaseline().files, ["a.ts"]);
  });

  it("reports an unverified file list when git is unavailable", () => {
    const h = harness();
    h.setFiles(null);
    const { files, verified } = h.rt.filesSinceBaseline();
    assert.equal(verified, false);
    assert.deepEqual(files, []);
  });
});

describe("pending checkpoint state machine", () => {
  it("returns an immediate result in off mode", () => {
    const { rt } = harness({ mode: "off" });
    const started = rt.beginCheckpoint();
    assert.ok("immediate" in started);
    assert.match(started.immediate.text, /not in agent-driver/);
  });

  it("rejects a second checkpoint while one is open", () => {
    const { rt } = harness();
    assert.ok("pending" in rt.beginCheckpoint());

    const second = rt.beginCheckpoint();
    assert.ok("immediate" in second);
    assert.match(second.immediate.text, /already open/);
  });

  it("allows a new checkpoint once the first resolves", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.resolvePending({ kind: "continue" });
    assert.ok("pending" in rt.beginCheckpoint());
  });

  it("resolves the promise exactly once, first outcome wins", async () => {
    const { rt } = harness();
    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);

    rt.resolvePending({ kind: "continue" });
    rt.resolvePending({ kind: "stop" }); // must be a no-op
    rt.resolvePending({ kind: "cancelled" }); // must be a no-op

    assert.deepEqual(await started.pending.promise, { kind: "continue" });
  });

  for (const [first, second] of [
    ["continue", "cancelled"],
    ["cancelled", "stop"],
    ["stop", "mode-off"],
    ["mode-off", "continue"],
  ] as const) {
    it(`race: ${first} then ${second} keeps the first`, async () => {
      const { rt } = harness();
      const started = rt.beginCheckpoint();
      assert.ok("pending" in started);

      rt.resolvePending({ kind: first } as never);
      rt.resolvePending({ kind: second } as never);
      assert.equal((await started.pending.promise).kind, first);
    });
  }

  it("resolving when nothing is pending is harmless", () => {
    const { rt } = harness();
    assert.doesNotThrow(() => rt.resolvePending({ kind: "cancelled" }));
  });
});

describe("mode switching", () => {
  it("off -> agent-driver starts from a clean budget", () => {
    const { rt } = harness({ mode: "off", max: 2 });
    rt.setMode("agent-driver");
    assert.equal(rt.checkpoint.snapshot().total, 0);
    assert.equal(edit(rt, "a"), undefined);
  });

  it("agent-driver -> off clears state and stops gating", () => {
    const { rt } = harness({ max: 1 });
    edit(rt, "a");
    assert.ok(edit(rt, "b")?.block);

    rt.setMode("off");
    assert.equal(rt.checkpoint.snapshot().total, 0);
    for (let i = 0; i < 10; i++) assert.equal(edit(rt, `x${i}`), undefined);
  });

  it("switching off resolves an open card as mode-off", async () => {
    const { rt } = harness();
    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);

    rt.setMode("off");
    assert.deepEqual(await started.pending.promise, { kind: "mode-off" });
    assert.equal(rt.isCheckpointPending(), false);
  });

  it("switching clears a stop latch", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    rt.applyOutcome({ kind: "stop" });
    rt.setMode("off");
    rt.setMode("agent-driver");
    assert.equal(edit(rt, "a"), undefined);
  });

  it("re-applying the same mode is a no-op", () => {
    const { rt } = harness({ max: 5 });
    edit(rt, "a");
    rt.setMode("agent-driver");
    assert.equal(rt.checkpoint.snapshot().total, 1, "budget must not silently reset");
  });
});

describe("run boundaries", () => {
  it("sweeps orphaned calls to a counted-but-unknown state", () => {
    const { rt } = harness({ max: 5 });
    edit(rt, "aborted");
    const outstanding = rt.onAgentSettled();

    assert.equal(outstanding, 1);
    assert.deepEqual(rt.checkpoint.snapshot(), {
      confirmed: 0,
      pending: 0,
      stale: 1,
      total: 1,
    });
  });

  it("never blocks at a run boundary", () => {
    const { rt } = harness({ max: 1 });
    edit(rt, "a");
    assert.doesNotThrow(() => rt.onAgentSettled());
  });

  it("an overdue budget is recoverable without the model's cooperation", () => {
    // The human can always open a checkpoint themselves.
    const { rt } = harness({ max: 1 });
    edit(rt, "a");
    assert.ok(edit(rt, "b")?.block);

    const started = rt.beginCheckpoint();
    assert.ok("pending" in started, "opening a checkpoint is never gated");
    rt.applyOutcome({ kind: "continue" });
    assert.equal(edit(rt, "c"), undefined);
  });
});

describe("status text", () => {
  it("shows the budget in agent-driver mode", () => {
    const { rt } = harness({ max: 5 });
    edit(rt, "a");
    assert.match(rt.statusText(), /driver 1\/5/);
  });

  it("shows stopped and awaiting states", () => {
    const { rt } = harness();
    rt.beginCheckpoint();
    assert.match(rt.statusText(), /awaiting you/);
    rt.applyOutcome({ kind: "stop" });
    assert.match(rt.statusText(), /stopped/);
  });
});
