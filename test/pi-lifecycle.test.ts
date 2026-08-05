import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_DRIVER_PERSONA,
  HUMAN_DRIVER_PERSONA,
  createPearSession,
  type ReviewCompletions,
} from "../adapters/shared/pear-runtime.ts";
import { DEFAULTS, type PearConfig } from "../core/config.ts";
import { createScheduler } from "../core/navigate.ts";

const cfg = (over: Partial<Required<PearConfig>> = {}): Required<PearConfig> => ({
  mode: "off",
  reviewModel: DEFAULTS.reviewModel,
  filterModel: DEFAULTS.filterModel,
  minLines: 1,
  debounceSeconds: 1,
  intervalSeconds: 1,
  checkpointSeconds: 300,
  maxChangesPerCheckpoint: 5,
  ...over,
});

function fakeUi(hasUI = true) {
  const notifies: Array<{ message: string; type?: string }> = [];
  const statuses: string[] = [];
  return {
    hasUI,
    notifies,
    statuses,
    notify: (message: string, type?: "info" | "warning" | "error") => {
      notifies.push({ message, type });
    },
    setStatus: (_key: string, text?: string) => {
      if (text) statuses.push(text);
    },
  };
}

const noCompletions: ReviewCompletions = { small: null, large: null };

describe("mode exclusivity", () => {
  it("agent-driver blocks at the cap; switching to human-driver never blocks; off has neither primitive", async () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "agent-driver", maxChangesPerCheckpoint: 2 }),
      completions: noCompletions,
      ui,
      onFindings: () => {},
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => true,
      fileStateHashesFn: () => new Map(),
      changedLines: () => 0,
      diffText: () => "",
      setInterval: () => 1,
      clearInterval: () => {},
    });
    assert.equal(s.mode, "agent-driver");
    assert.ok(s.checkpoint);
    assert.equal(s.scheduler, null);

    await s.onToolCall({ toolCallId: "1", toolName: "write", input: {} });
    s.onToolResult("1", false);
    await s.onToolCall({ toolCallId: "2", toolName: "write", input: {} });
    s.onToolResult("2", false);
    const blocked = await s.onToolCall({ toolCallId: "3", toolName: "write", input: {} });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /── checkpoint ──/);

    s.start();
    const completions: ReviewCompletions = { small: async () => "[]", large: async () => "[]" };
    s.setMode("human-driver", cfg({ mode: "human-driver" }), completions);
    assert.equal(s.mode, "human-driver");
    assert.ok(s.scheduler);
    assert.equal(s.checkpoint, null);

    const none = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => s.onToolCall({ toolCallId: `h${i}`, toolName: "write", input: {} })),
    );
    assert.ok(none.every((d) => d === undefined));

    s.setMode("off", cfg({ mode: "off" }), noCompletions);
    assert.equal(s.mode, "off");
    assert.equal(s.scheduler, null);
    assert.equal(s.checkpoint, null);
    const offDecision = await s.onToolCall({ toolCallId: "o1", toolName: "write", input: {} });
    assert.equal(offDecision, undefined);

    s.stop();
  });
});

describe("human-driver review delivery", () => {
  it("runReview success delivers findings via onFindings and returns ok", async () => {
    const findings: string[] = [];
    let resolveReview!: (v: { ok: true } | { ok: false; error: string }) => void;
    const done = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      resolveReview = resolve;
    });

    const sched = createScheduler(
      { minLines: 1, intervalSeconds: 0, debounceSeconds: 0 },
      {
        now: () => 1000,
        setTimeout: (fn) => {
          fn();
          return 1;
        },
        clearTimeout: () => {},
        getChangedLines: () => 10,
        getDiffText: () => "diff",
        runReview: async () => {
          findings.push("via-wrapper");
          const result = { ok: true as const };
          resolveReview(result);
          return result;
        },
        onOutput: () => {},
      },
    );
    sched.notify("abc");
    const result = await done;
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(findings, ["via-wrapper"]);
    sched.stop();
  });

  it("session review failure notifies an error and delivers no findings", async () => {
    let resolveErrored!: () => void;
    const errored = new Promise<void>((resolve) => {
      resolveErrored = resolve;
    });
    const ui = fakeUi();
    const baseNotify = ui.notify;
    ui.notify = (message, type) => {
      baseNotify(message, type);
      if (type === "error") resolveErrored();
    };
    const findings: string[] = [];
    let fire: (() => void) | null = null;
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "human-driver", debounceSeconds: 0, intervalSeconds: 0, minLines: 1 }),
      completions: {
        small: async () => {
          throw new Error("model down");
        },
        large: async () => "[]",
      },
      ui,
      onFindings: (t) => findings.push(t),
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => true,
      changedLines: () => 20,
      diffText: () => "d",
      setTimeout: (fn) => {
        fire = () => fn();
        return 1;
      },
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    });
    s.scheduler!.notify("hash1");
    assert.ok(fire);
    (fire as () => void)();
    await errored;
    assert.ok(ui.notifies.some((n) => n.type === "error" && /model down/.test(n.message)));
    assert.equal(findings.length, 0);
    s.stop();
  });
});

describe("off mode", () => {
  it("checkpoint/scheduler are both null; status/lifecycle hooks are safe no-ops", async () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "off" }),
      completions: noCompletions,
      ui,
      onFindings: () => {},
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => true,
    });
    assert.equal(s.checkpoint, null);
    assert.equal(s.scheduler, null);
    s.onAgentStart();
    await s.onAgentEnd();
    const d = await s.onToolCall({ toolCallId: "a", toolName: "write", input: {} });
    assert.equal(d, undefined);
    s.onToolResult("a", false); // no-op, must not throw
    assert.equal(s.statusText(), "pear: off — /pear-mode to start");
  });

  it("start/stop is idempotent and agent-driver never starts a poll", () => {
    const ui = fakeUi();
    let intervalCalls = 0;
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "agent-driver" }),
      completions: noCompletions,
      ui,
      onFindings: () => {},
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => true,
      fileStateHashesFn: () => new Map(),
      setInterval: () => {
        intervalCalls++;
        return 1;
      },
      clearInterval: () => {},
    });
    s.start();
    s.start();
    assert.equal(intervalCalls, 0, "agent-driver never polls");
    s.stop();
    s.stop();
  });

  it("human-driver polls only after start()", () => {
    const ui = fakeUi();
    let intervalCalls = 0;
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "human-driver" }),
      completions: { small: async () => "[]", large: async () => "[]" },
      ui,
      onFindings: () => {},
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => true,
      setInterval: () => {
        intervalCalls++;
        return 1;
      },
      clearInterval: () => {},
    });
    assert.equal(intervalCalls, 0, "no poll before start()");
    s.start();
    assert.equal(intervalCalls, 1);
    s.stop();
  });
});

describe("persona", () => {
  it("agent-driver persona names both contracts", () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "agent-driver" }),
      completions: noCompletions,
      ui,
      onFindings: () => {},
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => false,
    });
    const prompt = s.personaSystemPrompt("BASE");
    assert.match(prompt, /^BASE\n\n/);
    assert.match(prompt, /NOT EXECUTED — human steering/);
    assert.match(prompt, /checkpoint acknowledged; re-issue/);
    assert.equal(AGENT_DRIVER_PERSONA.includes("DRIVER"), true);
  });

  it("human-driver persona names pear-nav findings as informational", () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "human-driver" }),
      completions: { small: async () => "[]", large: async () => "[]" },
      ui,
      onFindings: () => {},
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => true,
    });
    assert.equal(s.mode, "human-driver");
    assert.match(s.personaSystemPrompt("BASE"), /pear-nav/);
    assert.equal(HUMAN_DRIVER_PERSONA.includes("pear-nav"), true);
  });

  it("off returns the base prompt unchanged", () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      cfg: cfg({ mode: "off" }),
      completions: noCompletions,
      ui,
      onFindings: () => {},
      sendUserMessage: () => {},
      saveConfig: () => {},
      gitOk: () => false,
    });
    assert.equal(s.personaSystemPrompt("BASE"), "BASE");
  });
});
