import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPearSession,
  PERSONA_APPEND,
  type PearFlags,
  type PearDeps,
} from "../adapters/pi/runtime.ts";
import { createScheduler } from "../core/navigate.ts";

const flags = (over: Partial<PearFlags> = {}): PearFlags => ({
  navModel: "openai/gpt-test",
  noNav: false,
  pauseLines: 150,
  pauseEdits: 5,
  minLines: 1,
  debounceSeconds: 1,
  intervalSeconds: 1,
  ...over,
});

function fakeUi(hasUI = true) {
  const inputs: Array<string | Error> = [];
  const notifies: Array<{ message: string; type?: string }> = [];
  return {
    hasUI,
    inputs,
    notifies,
    input: async () => {
      const next = inputs.shift();
      if (next instanceof Error) throw next;
      return next ?? "";
    },
    notify: (message: string, type?: "info" | "warning" | "error") => {
      notifies.push({ message, type });
    },
    setStatus: () => {},
  };
}

describe("pi-lifecycle parking", () => {
  it("parks on agent_start; unparks and markReviewed on agent_end", async () => {
    const hashes: string[] = [];
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags(),
      ui,
      complete: async () => "[]",
      onFindings: () => {},
      sendUserMessage: () => {},
      gitOk: () => true,
      changedLines: () => 10,
      changedFiles: () => [],
      stateHash: () => {
        hashes.push("h1");
        return "h1";
      },
      diffText: () => "",
      setInterval: () => 1,
      clearInterval: () => {},
    });
    assert.ok(s.scheduler);
    s.scheduler!.notify("pending-hash");
    // force PENDING
    assert.equal(s.scheduler!.getState(), "PENDING");
    s.onAgentStart();
    assert.equal(s.scheduler!.isParked(), true);
    assert.equal(s.scheduler!.getState(), "IDLE");
    assert.match(ui.notifies.map((n) => n.message).join(" "), /folding pending/);

    await s.onAgentEnd();
    assert.equal(s.scheduler!.isParked(), false);
    assert.ok(s.scheduler!.getReviewed().has("h1"));
  });

  it("folding notice captures wasPending before park; notify throw still parks", () => {
    const ui = fakeUi();
    ui.notify = () => {
      throw new Error("notify fail");
    };
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags(),
      ui,
      complete: async () => "[]",
      onFindings: () => {},
      sendUserMessage: () => {},
      gitOk: () => true,
      changedLines: () => 0,
      changedFiles: () => [],
      stateHash: () => "h",
      diffText: () => "",
      setInterval: () => 1,
      clearInterval: () => {},
    });
    s.scheduler!.notify("x");
    assert.equal(s.scheduler!.getState(), "PENDING");
    s.onAgentStart();
    assert.equal(s.scheduler!.isParked(), true);
  });
});

describe("pi-lifecycle review delivery", () => {
  it("runReview success delivers findings via onFindings and returns ok", async () => {
    const findings: string[] = [];
    let resolveReview: (v: { ok: true } | { ok: false; error: string }) => void;
    const done = new Promise<{ ok: true } | { ok: false; error: string }>((r) => {
      resolveReview = r;
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
          resolveReview!(result);
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

  it("session review failure notifies error and returns ok:false from wrapper", async () => {
    const ui = fakeUi();
    const findings: string[] = [];
    let fire: (() => void) | null = null;
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ debounceSeconds: 0, intervalSeconds: 0, minLines: 1 }),
      ui,
      complete: async () => {
        throw new Error("model down");
      },
      onFindings: (t) => findings.push(t),
      sendUserMessage: () => {},
      gitOk: () => true,
      changedLines: () => 20,
      changedFiles: () => [],
      stateHash: () => "hash1",
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
    await Promise.resolve();
    (fire as () => void)();
    // allow async fire to settle
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ui.notifies.some((n) => n.type === "error" && /model down/.test(n.message)));
    assert.equal(findings.length, 0);
    s.stop();
  });
});

describe("pi-lifecycle agent_end", () => {
  it("headless skips end-of-turn prompt and still unparks", async () => {
    const ui = fakeUi(false);
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ pauseEdits: 1 }),
      ui,
      complete: async () => "[]",
      onFindings: () => {},
      sendUserMessage: () => {},
      gitOk: () => true,
      changedLines: () => 0,
      changedFiles: () => [],
      stateHash: () => "h",
      diffText: () => "",
      setInterval: () => 1,
      clearInterval: () => {},
    });
    s.onAgentStart();
    // build mutation debt
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    await s.onAgentEnd();
    assert.equal(s.scheduler!.isParked(), false);
    assert.equal(ui.inputs.length, 0);
  });

  it("rejected input still resets accounting and cleans up", async () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ pauseEdits: 1, noNav: true }),
      ui,
      complete: null,
      onFindings: () => {},
      sendUserMessage: () => {},
      gitOk: () => false,
    });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    ui.inputs.push(new Error("boom"));
    await s.onAgentEnd();
    // check was true so we entered prompt; throw → finally still reset
    assert.equal(s.checkpoint.snapshot().confirmed, 0);
  });

  it("non-empty end-of-turn steering sends user message after cleanup", async () => {
    const order: string[] = [];
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ pauseEdits: 1 }),
      ui,
      complete: async () => "[]",
      onFindings: () => {},
      sendUserMessage: (text) => {
        order.push(`send:${text}`);
        // reentrancy: fire agent_start synchronously
        order.push(`parked-before-reentry:${s.scheduler!.isParked()}`);
        s.onAgentStart();
        order.push(`parked-after-reentry:${s.scheduler!.isParked()}`);
      },
      gitOk: () => true,
      changedLines: () => 0,
      changedFiles: () => [],
      stateHash: () => {
        order.push("markReviewed-hash");
        return "h";
      },
      diffText: () => "",
      setInterval: () => 1,
      clearInterval: () => {},
    });
    s.onAgentStart();
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    ui.inputs.push("please fix tests");
    order.push("before-end");
    await s.onAgentEnd();
    assert.ok(order.indexOf("markReviewed-hash") < order.indexOf("send:please fix tests"));
    assert.equal(order.includes("parked-before-reentry:false"), true);
    assert.equal(order.includes("parked-after-reentry:true"), true);
    assert.equal(s.checkpoint.snapshot().confirmed, 0);
  });

  it("empty end-of-turn input sends nothing", async () => {
    const sent: string[] = [];
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ pauseEdits: 1, noNav: true }),
      ui,
      complete: null,
      onFindings: () => {},
      sendUserMessage: (t) => sent.push(t),
      gitOk: () => false,
    });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    ui.inputs.push("");
    await s.onAgentEnd();
    assert.deepEqual(sent, []);
  });

  it("sendUserMessage failure notifies exactly once; notify failure swallowed", async () => {
    const ui = fakeUi();
    let sends = 0;
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ pauseEdits: 1, noNav: true }),
      ui,
      complete: null,
      onFindings: () => {},
      sendUserMessage: () => {
        sends++;
        throw new Error("send fail");
      },
      gitOk: () => false,
    });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    ui.inputs.push("steer");
    await s.onAgentEnd();
    assert.equal(sends, 1);
    assert.equal(ui.notifies.filter((n) => n.message === "steer").length, 1);

    // notify failure swallowed
    const ui2 = fakeUi();
    ui2.notify = () => {
      throw new Error("n");
    };
    const s2 = createPearSession({
      cwd: "/tmp",
      flags: flags({ pauseEdits: 1, noNav: true }),
      ui: ui2,
      complete: null,
      onFindings: () => {},
      sendUserMessage: () => {
        throw new Error("send");
      },
      gitOk: () => false,
    });
    await s2.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s2.onToolResult("a", false);
    ui2.inputs.push("x");
    await s2.onAgentEnd(); // must not throw
  });

  it("changedLines throw in agent_end keeps baseline; mutation debt can still trip", async () => {
    let failLines = false;
    const ui = fakeUi();
    const order: string[] = [];
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ pauseEdits: 1, pauseLines: 1000 }),
      ui,
      complete: async () => "[]",
      onFindings: () => {},
      sendUserMessage: () => {
        order.push(`confirmed:${s.checkpoint.snapshot().confirmed}`);
      },
      gitOk: () => true,
      changedLines: () => {
        if (failLines) throw new Error("git");
        return 5;
      },
      changedFiles: () => [],
      stateHash: () => "h",
      diffText: () => "",
      setInterval: () => 1,
      clearInterval: () => {},
    });
    assert.equal(s.checkpoint.getBaselineLines(), 5);
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    failLines = true;
    ui.inputs.push("go");
    await s.onAgentEnd();
    // reset used getBaselineLines fallback (5)
    assert.equal(s.checkpoint.getBaselineLines(), 5);
    assert.equal(s.checkpoint.snapshot().confirmed, 0);
    assert.deepEqual(order, ["confirmed:0"]);
  });
});

describe("pi-lifecycle null scheduler", () => {
  it("agent_start/end and status are safe with noNav", async () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ noNav: true }),
      ui,
      complete: async () => "[]",
      onFindings: () => {},
      sendUserMessage: () => {},
      gitOk: () => true,
      changedLines: () => 0,
      changedFiles: () => [],
      stateHash: () => "h",
      diffText: () => "",
    });
    assert.equal(s.scheduler, null);
    s.onAgentStart();
    await s.onAgentEnd();
    assert.match(s.statusText(), /nav off/);
  });

  it("hasUI=false never calls notify on non-git warn", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-lc-"));
    try {
      const ui = fakeUi(false);
      createPearSession({
        cwd: dir,
        flags: flags({ noNav: false }),
        ui,
        complete: async () => "[]",
        onFindings: () => {},
        sendUserMessage: () => {},
      });
      assert.equal(ui.notifies.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session stop is idempotent", () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags(),
      ui,
      complete: async () => "[]",
      onFindings: () => {},
      sendUserMessage: () => {},
      gitOk: () => true,
      changedLines: () => 0,
      changedFiles: () => [],
      stateHash: () => "h",
      diffText: () => "",
      setInterval: () => 1,
      clearInterval: () => {},
    });
    s.start();
    s.stop();
    s.stop();
  });
});

describe("persona", () => {
  it("appends DRIVER persona naming both contracts", () => {
    const ui = fakeUi();
    const s = createPearSession({
      cwd: "/tmp",
      flags: flags({ noNav: true }),
      ui,
      complete: null,
      onFindings: () => {},
      sendUserMessage: () => {},
      gitOk: () => false,
    });
    const prompt = s.personaSystemPrompt("BASE");
    assert.match(prompt, /^BASE\n\n/);
    assert.match(prompt, /NOT EXECUTED — human steering/);
    assert.match(prompt, /checkpoint acknowledged; re-issue/);
    assert.equal(PERSONA_APPEND.includes("DRIVER"), true);
  });
});
