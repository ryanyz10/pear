import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ACK_CONTRACT,
  STEERING_CONTRACT,
  SUPERSEDED_REASON,
  createPearSession,
  type PearDeps,
  type PearFlags,
  type PearSession,
} from "../adapters/pi/runtime.ts";

const flags = (over: Partial<PearFlags> = {}): PearFlags => ({
  navModel: "openai/gpt-test",
  noNav: true,
  pauseLines: 150,
  pauseEdits: 5,
  minLines: 50,
  debounceSeconds: 10,
  intervalSeconds: 60,
  ...over,
});

type FakeUi = {
  hasUI: boolean;
  inputs: Array<string | Error>;
  notifies: Array<{ message: string; type?: string }>;
  statuses: string[];
};

function fakeUi(hasUI = true): FakeUi & PearDeps["ui"] {
  const inputs: Array<string | Error> = [];
  const notifies: Array<{ message: string; type?: string }> = [];
  const statuses: string[] = [];
  return {
    hasUI,
    inputs,
    notifies,
    statuses,
    input: async () => {
      const next = inputs.shift();
      if (next instanceof Error) throw next;
      return next ?? "";
    },
    notify: (message, type) => {
      notifies.push({ message, type });
    },
    setStatus: (_key, text) => {
      if (text) statuses.push(text);
    },
  };
}

function session(
  ui: ReturnType<typeof fakeUi>,
  over: Partial<PearDeps> & { flags?: PearFlags } = {},
): PearSession {
  return createPearSession({
    cwd: over.cwd ?? "/tmp/pear-nongit",
    flags: over.flags ?? flags(),
    ui,
    complete: over.complete ?? null,
    onFindings: over.onFindings ?? (() => {}),
    sendUserMessage: over.sendUserMessage ?? (() => {}),
    gitOk: over.gitOk ?? (() => false),
    changedLines: over.changedLines,
    changedFiles: over.changedFiles,
    stateHash: over.stateHash,
    diffText: over.diffText,
    ...over,
  });
}

describe("pi-gate under budget", () => {
  it("allows and reserves when under budget", async () => {
    const ui = fakeUi();
    const s = session(ui, { flags: flags({ pauseEdits: 5 }) });
    const d = await s.onToolCall({ toolCallId: "1", toolName: "write", input: { path: "a.ts" } });
    assert.equal(d, undefined);
    assert.equal(s.checkpoint.snapshot().pending, 1);
    s.onToolResult("1", false);
    assert.equal(s.checkpoint.snapshot().confirmed, 1);
    assert.equal(s.checkpoint.snapshot().pending, 0);
  });
});

describe("pi-gate always-block checkpoint", () => {
  it("empty input → ACK_CONTRACT, no reservation, suppresses batch", async () => {
    const ui = fakeUi();
    const s = session(ui, { flags: flags({ pauseEdits: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a.ts" } });
    s.onToolResult("a", false);

    ui.inputs.push("");
    const blocked = await s.onToolCall({
      toolCallId: "b",
      toolName: "write",
      input: { path: "b.ts" },
    });
    assert.deepEqual(blocked, { block: true, reason: ACK_CONTRACT });
    assert.equal(s.checkpoint.snapshot().pending, 0);

    const sibling = await s.onToolCall({
      toolCallId: "c",
      toolName: "edit",
      input: { path: "c.ts" },
    });
    assert.deepEqual(sibling, { block: true, reason: SUPERSEDED_REASON });
    assert.equal(s.checkpoint.snapshot().pending, 0);

    s.onTurnEnd();
    const next = await s.onToolCall({
      toolCallId: "d",
      toolName: "write",
      input: { path: "d.ts" },
    });
    assert.equal(next, undefined);
    assert.equal(s.checkpoint.snapshot().pending, 1);
  });

  it("steering text → STEERING_CONTRACT + text and suppresses", async () => {
    const ui = fakeUi();
    const s = session(ui, { flags: flags({ pauseEdits: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "bash", input: { command: "true" } });
    s.onToolResult("a", false);

    ui.inputs.push("stop and rethink");
    const blocked = await s.onToolCall({
      toolCallId: "b",
      toolName: "bash",
      input: { command: "rm -rf /" },
    });
    assert.deepEqual(blocked, {
      block: true,
      reason: STEERING_CONTRACT + "stop and rethink",
    });
    const sibling = await s.onToolCall({
      toolCallId: "c",
      toolName: "write",
      input: { path: "x" },
    });
    assert.equal(sibling?.reason, SUPERSEDED_REASON);
  });
});

describe("pi-gate headless and fail-open", () => {
  it("hasUI=false allows without reserving", async () => {
    const ui = fakeUi(false);
    const s = session(ui, { flags: flags({ pauseEdits: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    // over budget but headless
    const d = await s.onToolCall({ toolCallId: "b", toolName: "write", input: { path: "b" } });
    assert.equal(d, undefined);
    assert.equal(s.checkpoint.snapshot().pending, 0);
    s.onToolResult("b", false); // no-op settle
    assert.equal(s.checkpoint.snapshot().confirmed, 1);
  });

  it("input throw fails open with reservation after pending-aware reset", async () => {
    const ui = fakeUi();
    const s = session(ui, { flags: flags({ pauseEdits: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);

    ui.inputs.push(new Error("ui down"));
    const d = await s.onToolCall({ toolCallId: "b", toolName: "write", input: { path: "b" } });
    assert.equal(d, undefined);
    assert.equal(s.checkpoint.snapshot().pending, 1);
    s.onToolResult("b", false);
    assert.equal(s.checkpoint.snapshot().confirmed, 1);
  });
});

describe("pi-gate concurrent siblings", () => {
  it("N+1th preflight trips via reservations; failed settle releases", async () => {
    const ui = fakeUi();
    const s = session(ui, { flags: flags({ pauseEdits: 3 }) });
    for (let i = 0; i < 3; i++) {
      const d = await s.onToolCall({
        toolCallId: `c${i}`,
        toolName: "write",
        input: { path: `${i}` },
      });
      assert.equal(d, undefined);
    }
    ui.inputs.push("");
    const trip = await s.onToolCall({
      toolCallId: "c3",
      toolName: "write",
      input: { path: "3" },
    });
    assert.equal(trip?.block, true);
    // settle earlier batch with one error
    s.onToolResult("c0", true);
    s.onToolResult("c1", false);
    s.onToolResult("c2", false);
    // blocked c3 settle no-ops
    s.onToolResult("c3", true);
    assert.equal(s.checkpoint.snapshot().pending, 0);
  });
});

describe("pi-gate deferred rebase", () => {
  it("mid-batch checkpoint defers baseline; turn_end finishRebase; next turn charges own lines", async () => {
    let lines = 10;
    const ui = fakeUi();
    const s = session(ui, {
      flags: flags({ pauseEdits: 2, pauseLines: 20 }),
      gitOk: () => true,
      changedLines: () => lines,
      changedFiles: () => ["a.ts"],
      stateHash: () => `h${lines}`,
      diffText: () => "",
    });
    // init baseline was 10
    assert.equal(s.checkpoint.getBaselineLines(), 10);

    await s.onToolCall({ toolCallId: "1", toolName: "write", input: { path: "a" } });
    await s.onToolCall({ toolCallId: "2", toolName: "write", input: { path: "b" } });
    // pending=2, trip on 3rd
    ui.inputs.push("");
    const blocked = await s.onToolCall({
      toolCallId: "3",
      toolName: "write",
      input: { path: "c" },
    });
    assert.equal(blocked?.block, true);
    assert.equal(s.checkpoint.snapshot().rebasePending, true);
    // late sibling write lands on disk before turn_end
    lines = 40;
    s.onTurnEnd();
    assert.equal(s.checkpoint.snapshot().rebasePending, false);
    assert.equal(s.checkpoint.getBaselineLines(), 40);

    // next turn re-issue under new baseline — own writes of +5 don't trip pauseLines=20
    lines = 45;
    const ok = await s.onToolCall({
      toolCallId: "4",
      toolName: "write",
      input: { path: "d" },
    });
    assert.equal(ok, undefined);
    s.onToolResult("4", false);

    // oversized jump trips on following preflight
    lines = 100;
    ui.inputs.push("");
    const trip = await s.onToolCall({
      toolCallId: "5",
      toolName: "write",
      input: { path: "e" },
    });
    assert.equal(trip?.block, true);
  });

  it("turn_end read failure abandons rebase and keeps old baseline", async () => {
    let fail = false;
    let lines = 5;
    const ui = fakeUi();
    const s = session(ui, {
      flags: flags({ pauseEdits: 2 }),
      gitOk: () => true,
      changedLines: () => {
        if (fail) throw new Error("git down");
        return lines;
      },
      changedFiles: () => [],
      stateHash: () => "h",
      diffText: () => "",
    });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    await s.onToolCall({ toolCallId: "x", toolName: "write", input: { path: "x" } });
    ui.inputs.push("");
    await s.onToolCall({ toolCallId: "b", toolName: "write", input: { path: "b" } });
    assert.equal(s.checkpoint.snapshot().rebasePending, true);
    const old = s.checkpoint.getBaselineLines();
    fail = true;
    s.onTurnEnd();
    assert.equal(s.checkpoint.snapshot().rebasePending, false);
    assert.equal(s.checkpoint.getBaselineLines(), old);
  });
});

describe("pi-gate non-git and git-read failures", () => {
  it("non-git never calls changedLines and paces mutations only", async () => {
    const ui = fakeUi();
    let called = 0;
    const s = session(ui, {
      flags: flags({ pauseEdits: 2 }),
      gitOk: () => false,
      changedLines: () => {
        called++;
        throw new Error("should not call");
      },
    });
    await s.onToolCall({ toolCallId: "1", toolName: "write", input: { path: "a" } });
    s.onToolResult("1", false);
    await s.onToolCall({ toolCallId: "2", toolName: "write", input: { path: "b" } });
    s.onToolResult("2", false);
    ui.inputs.push("");
    const trip = await s.onToolCall({
      toolCallId: "3",
      toolName: "write",
      input: { path: "c" },
    });
    assert.equal(trip?.block, true);
    assert.equal(called, 0);
    assert.equal(s.checkpoint.snapshot().rebasePending, false);
  });

  it("preflight read throw → mutation-only check; nothing escapes", async () => {
    const ui = fakeUi();
    const s = session(ui, {
      flags: flags({ pauseEdits: 1, pauseLines: 1000 }),
      gitOk: () => true,
      changedLines: () => {
        throw new Error("boom");
      },
      changedFiles: () => [],
      stateHash: () => "h",
      diffText: () => "",
    });
    // baseline init fell back to 0
    assert.equal(s.checkpoint.getBaselineLines(), 0);
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    ui.inputs.push("");
    const trip = await s.onToolCall({
      toolCallId: "b",
      toolName: "write",
      input: { path: "b" },
    });
    assert.equal(trip?.block, true);
  });
});

describe("pi-gate initial baseline", () => {
  it("pre-existing uncommitted lines do not consume budget", async () => {
    const ui = fakeUi();
    const s = session(ui, {
      flags: flags({ pauseLines: 50, pauseEdits: 100 }),
      gitOk: () => true,
      changedLines: () => 80,
      changedFiles: () => ["old.ts"],
      stateHash: () => "h",
      diffText: () => "",
    });
    assert.equal(s.checkpoint.getBaselineLines(), 80);
    const d = await s.onToolCall({
      toolCallId: "1",
      toolName: "write",
      input: { path: "a" },
    });
    assert.equal(d, undefined);
  });
});

describe("pi-gate outage recovery", () => {
  it("abandon then oversized write remains chargeable after recovery", async () => {
    let lines = 10;
    let fail = false;
    const ui = fakeUi();
    const s = session(ui, {
      flags: flags({ pauseEdits: 2, pauseLines: 30 }),
      gitOk: () => true,
      changedLines: () => {
        if (fail) throw new Error("down");
        return lines;
      },
      changedFiles: () => [],
      stateHash: () => `h${lines}`,
      diffText: () => "",
    });
    // two in-flight so reset defers
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    await s.onToolCall({ toolCallId: "p", toolName: "write", input: { path: "p" } });
    ui.inputs.push("");
    await s.onToolCall({ toolCallId: "b", toolName: "write", input: { path: "b" } });
    assert.equal(s.checkpoint.snapshot().rebasePending, true);
    fail = true;
    s.onTurnEnd(); // abandon
    assert.equal(s.checkpoint.getBaselineLines(), 10);

    fail = false;
    lines = 50; // includes outage writes relative to old baseline
    ui.inputs.push("");
    const trip = await s.onToolCall({
      toolCallId: "c",
      toolName: "write",
      input: { path: "c" },
    });
    assert.equal(trip?.block, true);
  });
});

describe("gitOk detection in real temp dir", () => {
  it("non-git temp dir disables navigator", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-nongit-"));
    try {
      const ui = fakeUi();
      const s = createPearSession({
        cwd: dir,
        flags: flags({ noNav: false }),
        ui,
        complete: async () => "[]",
        onFindings: () => {},
        sendUserMessage: () => {},
      });
      assert.equal(s.isGit, false);
      assert.equal(s.scheduler, null);
      assert.match(ui.notifies[0]?.message ?? "", /not a git repo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git temp dir enables navigator when complete provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-git-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "hi\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "i"], { cwd: dir });
      const ui = fakeUi();
      const s = createPearSession({
        cwd: dir,
        flags: flags({ noNav: false }),
        ui,
        complete: async () => "[]",
        onFindings: () => {},
        sendUserMessage: () => {},
      });
      assert.equal(s.isGit, true);
      assert.ok(s.scheduler);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
