import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileState } from "../core/checkpoint.ts";
import { DEFAULTS } from "../core/config.ts";
import { formatPlan, type PlanSpec } from "../core/prompts.ts";
import { createRuntime, type PearRuntime } from "../adapters/pi/runtime.ts";

function harness(
  overrides: { mode?: "off" | "agent-driver"; planPhase?: boolean; budget?: number } = {},
): { rt: PearRuntime; setFiles: (f: Record<string, string> | null) => void } {
  let files: FileState | null = new Map();
  const rt = createRuntime({
    mode: overrides.mode ?? "agent-driver",
    reviewBudget: overrides.budget ?? DEFAULTS.reviewBudget,
    planPhase: overrides.planPhase ?? true,
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

const PLAN: PlanSpec = {
  summary: "Wrap the sync client in a retry so transient 5xx stop killing the job.",
  steps: ["Add the retry helper", "Wire it into the client", "Cover it with a test"],
};

const write = (rt: PearRuntime, id: string, path = "f.ts") =>
  rt.onMutatingToolCall("write", id, { path, content: "x" });

const bash = (rt: PearRuntime, id: string, command: string) =>
  rt.onMutatingToolCall("bash", id, { command });

/** Approve `PLAN` and land in the building phase. */
function approve(rt: PearRuntime): void {
  const started = rt.beginPlan();
  assert.ok("pending" in started);
  started.pending.settle({ kind: "approve" });
  rt.applyPlanAnswer({ kind: "approve" }, PLAN);
}

describe("phases", () => {
  it("starts in scoping when planPhase is on", () => {
    const { rt } = harness({ planPhase: true });
    assert.equal(rt.phase, "scoping");
    assert.equal(rt.plan, null);
  });

  it("starts in building when planPhase is off", () => {
    const { rt } = harness({ planPhase: false });
    assert.equal(rt.phase, "building");
  });

  it("approving a plan moves to building and records it", () => {
    const { rt } = harness();
    approve(rt);
    assert.equal(rt.phase, "building");
    assert.deepEqual(rt.plan, PLAN);
    assert.equal(rt.planText(), formatPlan(PLAN));
  });

  it("returns to scoping on replan, keeping the last plan for reference", () => {
    const { rt } = harness();
    approve(rt);
    rt.replan();
    assert.equal(rt.phase, "scoping");
    assert.deepEqual(rt.plan, PLAN, "still available to show the human");
    assert.ok(write(rt, "a")?.block, "but editing is closed again");
  });

  it("adopts a plan recovered from session history without re-approving it", () => {
    const { rt } = harness();
    rt.restorePlan(PLAN);
    assert.equal(rt.phase, "building");
    assert.deepEqual(rt.plan, PLAN);
    assert.equal(write(rt, "a"), undefined, "editing is open again after a reload");
  });

  it("switching mode resets the phase and forgets the plan", () => {
    const { rt } = harness();
    approve(rt);
    rt.setMode("off");
    rt.setMode("agent-driver");
    assert.equal(rt.phase, "scoping");
    assert.equal(rt.plan, null);
  });
});

describe("scoping blocks every change", () => {
  it("blocks write and edit", () => {
    const { rt } = harness();
    assert.match(write(rt, "a")?.reason ?? "", /no plan is approved/);
    const editBlock = rt.onMutatingToolCall("edit", "b", {
      path: "f.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    assert.ok(editBlock?.block);
  });

  it("blocks a mutating bash command, which setActiveTools cannot", () => {
    // edit/write are removed from the tool set during scoping, but bash has to
    // stay for read-only work — so this hook is the only thing standing between
    // a mutating shell command and the working tree.
    const { rt } = harness();
    assert.ok(bash(rt, "a", "rm -rf build")?.block);
  });

  it("still allows read-only bash", () => {
    const { rt } = harness();
    assert.equal(bash(rt, "a", "git status"), undefined);
    assert.equal(bash(rt, "b", "rg pattern"), undefined);
  });

  it("opens up once a plan is approved", () => {
    const { rt } = harness();
    assert.ok(write(rt, "a")?.block);
    approve(rt);
    assert.equal(write(rt, "b"), undefined);
  });

  it("starts the build window clean, whatever happened while scoping", () => {
    const h = harness();
    h.setFiles({ "pre-existing.ts": "h:1" });
    approve(h.rt);
    assert.deepEqual(h.rt.filesSinceBaseline().files, []);
  });
});

describe("plan answers", () => {
  it("approve tells the agent it can edit now", () => {
    const { rt } = harness();
    rt.beginPlan();
    const res = rt.applyPlanAnswer({ kind: "approve" }, PLAN);
    assert.match(res.text, /plan approved/);
    assert.equal(res.terminate, false);
  });

  it("revise passes the human's words through and keeps scoping", () => {
    const { rt } = harness();
    rt.beginPlan();
    const res = rt.applyPlanAnswer({ kind: "revise", text: "do the test first" }, PLAN);
    assert.match(res.text, /do the test first/);
    assert.equal(res.terminate, false);
    assert.equal(rt.phase, "scoping");
    assert.equal(rt.plan, null, "an unapproved plan is not recorded");
  });

  it("keep exploring keeps scoping", () => {
    const { rt } = harness();
    rt.beginPlan();
    const res = rt.applyPlanAnswer({ kind: "explore" }, PLAN);
    assert.match(res.text, /keep looking/);
    assert.equal(rt.phase, "scoping");
  });

  it("dismissing ends the turn and pauses", () => {
    const { rt } = harness();
    rt.beginPlan();
    const res = rt.applyPlanAnswer({ kind: "dismissed" }, PLAN);
    assert.equal(res.terminate, true);
    assert.equal(rt.paused, true);
    assert.equal(rt.phase, "scoping");
  });

  it("mode-off neither approves nor terminates", () => {
    const { rt } = harness();
    rt.beginPlan();
    const res = rt.applyPlanAnswer({ kind: "mode-off" }, PLAN);
    assert.equal(res.terminate, false);
    assert.equal(rt.phase, "scoping");
  });
});

describe("ask answers", () => {
  it("passes the answer through verbatim", () => {
    const { rt } = harness();
    rt.beginAsk();
    const res = rt.applyAskAnswer({ kind: "answer", text: "use the existing queue" });
    assert.match(res.text, /use the existing queue/);
    assert.equal(res.terminate, false);
  });

  it("is available in both phases, since it is how the agent gets unstuck", () => {
    const { rt } = harness();
    assert.ok("pending" in rt.beginAsk(), "scoping");
    rt.resolvePending({ kind: "dismissed" });
    rt.onUserInput();
    approve(rt);
    assert.ok("pending" in rt.beginAsk(), "building");
  });

  it("dismissing ends the turn rather than letting the agent guess", () => {
    const { rt } = harness();
    rt.beginAsk();
    const res = rt.applyAskAnswer({ kind: "dismissed" });
    assert.equal(res.terminate, true);
    assert.match(res.text, /rather than guessing/);
  });
});

describe("out-of-phase tool calls", () => {
  it("pear_plan during building explains itself instead of opening a card", () => {
    const { rt } = harness();
    approve(rt);
    const started = rt.beginPlan();
    assert.ok("immediate" in started);
    assert.match(started.immediate.text, /already approved/);
    assert.equal(started.immediate.terminate, false);
    assert.equal(rt.isCardPending(), false);
  });

  it("pear_checkpoint during scoping explains itself instead of opening a card", () => {
    const { rt } = harness();
    const started = rt.beginCheckpoint();
    assert.ok("immediate" in started);
    assert.match(started.immediate.text, /no plan is approved/);
    assert.equal(started.immediate.terminate, false);
    assert.equal(rt.isCardPending(), false);
  });

  it("every tool is inert when the mode is off", () => {
    const { rt } = harness({ mode: "off" });
    for (const start of [rt.beginAsk(), rt.beginPlan(), rt.beginCheckpoint()]) {
      assert.ok("immediate" in start);
      assert.match(start.immediate.text, /not in agent-driver/);
      assert.equal(start.immediate.terminate, false);
    }
  });
});

describe("walking through a file", () => {
  const walk = (rt: PearRuntime, file = "src/retry.ts") => {
    const started = rt.beginCheckpoint();
    assert.ok("pending" in started);
    started.pending.settle({ kind: "explain", file });
    return rt.applyCheckpointAnswer({ kind: "explain", file });
  };

  it("hands back an instruction without ending the turn", () => {
    const { rt } = harness({ planPhase: false });
    const res = walk(rt);
    assert.match(res.text, /walk me through/);
    assert.match(res.text, /src\/retry\.ts/);
    assert.match(res.text, /call pear_checkpoint again/);
    assert.equal(res.terminate, false, "the agent has to keep talking");
  });

  it("blocks edits while the human is reading", () => {
    const { rt } = harness({ planPhase: false });
    walk(rt);
    const blocked = write(rt, "a");
    assert.ok(blocked?.block);
    assert.match(blocked.reason, /is reviewing/);
    assert.match(blocked.reason, /src\/retry\.ts/);
  });

  it("still allows reading, which is the whole point", () => {
    const { rt } = harness({ planPhase: false });
    walk(rt);
    assert.equal(bash(rt, "a", "cat src/retry.ts"), undefined);
  });

  it("does NOT acknowledge the change set", () => {
    const h = harness({ planPhase: false });
    h.setFiles({ "a.ts": "h:1" });
    walk(h.rt);
    assert.deepEqual(
      h.rt.filesSinceBaseline().files,
      ["a.ts"],
      "the same changes must be there when they come back to answer",
    );
  });

  it("is cleared by the follow-up checkpoint, so the loop resumes", () => {
    const { rt } = harness({ planPhase: false });
    walk(rt);
    assert.equal(rt.explaining, "src/retry.ts");

    const again = rt.beginCheckpoint();
    assert.ok("pending" in again, "re-opening is never gated");
    assert.equal(rt.explaining, null, "showing the card again ends the walkthrough");

    again.pending.settle({ kind: "continue" });
    rt.applyCheckpointAnswer({ kind: "continue" });
    assert.equal(write(rt, "a"), undefined);
  });

  it("survives the run boundary and is reported, so the human is not left hanging", () => {
    const { rt } = harness({ planPhase: false });
    walk(rt);
    const report = rt.onAgentSettled();
    assert.equal(report.awaitingExplanation, "src/retry.ts");
    assert.ok(write(rt, "a")?.block, "the hold is the human's, not the run's");
  });

  it("is cleared by genuine user input", () => {
    const { rt } = harness({ planPhase: false });
    walk(rt);
    rt.onUserInput();
    assert.equal(rt.explaining, null);
    assert.equal(write(rt, "a"), undefined);
  });

  it("does not open a second card when re-asked", () => {
    const { rt } = harness({ planPhase: false });
    walk(rt, "a.ts");
    const again = rt.beginCheckpoint();
    assert.ok("pending" in again);
    const third = rt.beginCheckpoint();
    assert.ok("immediate" in third);
    assert.match(third.immediate.text, /already open/);
  });
});

describe("formatPlan", () => {
  it("numbers the steps", () => {
    assert.equal(
      formatPlan({ summary: "Do the thing.", steps: ["First", "Second"] }),
      "Do the thing.\n\n1. First\n2. Second",
    );
  });

  it("renders a summary with no steps", () => {
    assert.equal(formatPlan({ summary: "Just this.", steps: [] }), "Just this.");
  });

  it("includes risks when there are any", () => {
    const text = formatPlan({ summary: "S", steps: ["A"], risks: ["Might break X"] });
    assert.match(text, /Watch out for:\n- Might break X/);
  });

  it("omits the risks section when empty", () => {
    assert.doesNotMatch(formatPlan({ summary: "S", steps: ["A"], risks: [] }), /Watch out/);
  });
});
