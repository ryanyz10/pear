import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  STEERING_CONTRACT,
  SUPERSEDED_REASON,
  createPearSession,
  type PearDeps,
  type PearSession,
  type ReviewCompletions,
} from "../adapters/shared/pear-runtime.ts";
import { DEFAULTS, type PearConfig } from "../core/config.ts";

const cfg = (over: Partial<Required<PearConfig>> = {}): Required<PearConfig> => ({
  mode: "agent-driver",
  reviewModel: DEFAULTS.reviewModel,
  filterModel: DEFAULTS.filterModel,
  minLines: DEFAULTS.minLines,
  debounceSeconds: DEFAULTS.debounceSeconds,
  intervalSeconds: DEFAULTS.intervalSeconds,
  checkpointSeconds: 300,
  maxChangesPerCheckpoint: 5,
  ...over,
});

const noCompletions: ReviewCompletions = { small: null, large: null };

type FakeUi = {
  hasUI: boolean;
  notifies: Array<{ message: string; type?: string }>;
  statuses: string[];
};

function fakeUi(hasUI = true): FakeUi & PearDeps["ui"] {
  const notifies: Array<{ message: string; type?: string }> = [];
  const statuses: string[] = [];
  return {
    hasUI,
    notifies,
    statuses,
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
  over: Partial<PearDeps> & { cfg?: Required<PearConfig> } = {},
): PearSession {
  return createPearSession({
    cwd: over.cwd ?? "/tmp/pear-nongit",
    cfg: over.cfg ?? cfg(),
    completions: over.completions ?? noCompletions,
    ui,
    onFindings: over.onFindings ?? (() => {}),
    sendUserMessage: over.sendUserMessage ?? (() => {}),
    saveConfig: over.saveConfig ?? (() => {}),
    gitOk: over.gitOk ?? (() => false),
    changedLines: over.changedLines,
    diffText: over.diffText,
    quickStateHash: over.quickStateHash,
    fileStateHashesFn: over.fileStateHashesFn,
    now: over.now,
    setTimeout: over.setTimeout,
    clearTimeout: over.clearTimeout,
    setInterval: over.setInterval,
    clearInterval: over.clearInterval,
  });
}

describe("pi-gate under budget", () => {
  it("allows and reserves when under budget", async () => {
    const ui = fakeUi();
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 5 }) });
    const d = await s.onToolCall({ toolCallId: "1", toolName: "write", input: { path: "a.ts" } });
    assert.equal(d, undefined);
    assert.equal(s.checkpoint!.snapshot().pending, 1);
    s.onToolResult("1", false);
    assert.equal(s.checkpoint!.snapshot().confirmed, 1);
    assert.equal(s.checkpoint!.snapshot().pending, 0);
  });
});

describe("pi-gate always-block checkpoint", () => {
  it("blocks immediately with a conversational checkpoint and suppresses the batch", async () => {
    const ui = fakeUi();
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a.ts" } });
    s.onToolResult("a", false);

    const blocked = await s.onToolCall({
      toolCallId: "b",
      toolName: "write",
      input: { path: "b.ts" },
    });
    assert.equal(blocked?.block, true);
    assert.ok(blocked?.reason.startsWith(STEERING_CONTRACT));
    assert.match(blocked?.reason ?? "", /── checkpoint ──/);
    assert.match(blocked?.reason ?? "", /Relay this checkpoint to the user/);
    assert.equal(s.checkpoint!.snapshot().pending, 0);
    assert.match(ui.notifies.at(-1)?.message ?? "", /about to: write b\.ts/);

    const sibling = await s.onToolCall({
      toolCallId: "c",
      toolName: "edit",
      input: { path: "c.ts" },
    });
    assert.deepEqual(sibling, { block: true, reason: SUPERSEDED_REASON });
    assert.equal(s.checkpoint!.snapshot().pending, 0);

    s.onTurnEnd();
    const next = await s.onToolCall({
      toolCallId: "d",
      toolName: "write",
      input: { path: "d.ts" },
    });
    assert.equal(next, undefined);
    assert.equal(s.checkpoint!.snapshot().pending, 1);
  });

  it("clears suppression at the next agent turn after an abort", async () => {
    const ui = fakeUi();
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: {} });
    s.onToolResult("a", false);
    const blocked = await s.onToolCall({ toolCallId: "b", toolName: "write", input: {} });
    assert.equal(blocked?.block, true);

    s.onAgentStart();
    const next = await s.onToolCall({ toolCallId: "c", toolName: "write", input: {} });
    assert.equal(next, undefined);
  });

  it("uses the canonical steering contract in the immediate block", async () => {
    const ui = fakeUi();
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "bash", input: { command: "true" } });
    s.onToolResult("a", false);

    const blocked = await s.onToolCall({
      toolCallId: "b",
      toolName: "bash",
      input: { command: "rm -rf /" },
    });
    assert.equal(blocked?.block, true);
    assert.ok(blocked?.reason.includes(STEERING_CONTRACT));
    assert.match(blocked?.reason ?? "", /awaiting user reply/);
    const sibling = await s.onToolCall({
      toolCallId: "c",
      toolName: "write",
      input: { path: "x" },
    });
    assert.equal(sibling?.reason, SUPERSEDED_REASON);
  });
});

describe("pi-gate headless and immediate block", () => {
  it("hasUI=false allows without reserving", async () => {
    const ui = fakeUi(false);
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    const d = await s.onToolCall({ toolCallId: "b", toolName: "write", input: { path: "b" } });
    assert.equal(d, undefined);
    assert.equal(s.checkpoint!.snapshot().pending, 0);
    s.onToolResult("b", false);
    assert.equal(s.checkpoint!.snapshot().confirmed, 1);
  });

  it("resolves the block synchronously, with a NOT EXECUTED reason", async () => {
    const ui = fakeUi();
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 1 }) });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);

    const d = await s.onToolCall({ toolCallId: "b", toolName: "write", input: { path: "b" } });
    assert.equal(d?.block, true);
    assert.match(d?.reason ?? "", /NOT EXECUTED/);
    assert.equal(s.checkpoint!.snapshot().pending, 0);
  });
});

describe("pi-gate concurrent siblings", () => {
  it("N+1th preflight trips via reservations; failed settle releases", async () => {
    const ui = fakeUi();
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 3 }) });
    for (let i = 0; i < 3; i++) {
      const d = await s.onToolCall({
        toolCallId: `c${i}`,
        toolName: "write",
        input: { path: `${i}` },
      });
      assert.equal(d, undefined);
    }
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
    assert.equal(s.checkpoint!.snapshot().pending, 0);
  });

  it("synchronously suppresses concurrent siblings before either can prompt", async () => {
    const ui = fakeUi();
    const s = session(ui, { cfg: cfg({ maxChangesPerCheckpoint: 1 }) });
    await s.onToolCall({ toolCallId: "seed", toolName: "write", input: {} });
    s.onToolResult("seed", false);

    const [first, sibling] = await Promise.all([
      s.onToolCall({ toolCallId: "first", toolName: "write", input: {} }),
      s.onToolCall({ toolCallId: "sibling", toolName: "edit", input: {} }),
    ]);
    assert.ok(first?.reason.startsWith(STEERING_CONTRACT));
    assert.deepEqual(sibling, { block: true, reason: SUPERSEDED_REASON });
    assert.equal(
      ui.notifies.filter(({ message }) => message.includes("── checkpoint ──")).length,
      1,
    );
  });
});

describe("pi-gate cadence", () => {
  it("OR semantics: elapsed time alone trips the checkpoint with zero changes", async () => {
    let nowMs = 0;
    const ui = fakeUi();
    const s = session(ui, {
      cfg: cfg({ checkpointSeconds: 10, maxChangesPerCheckpoint: 1000 }),
      now: () => nowMs,
    });
    nowMs = 5_000;
    const under = await s.onToolCall({ toolCallId: "a", toolName: "write", input: {} });
    assert.equal(under, undefined);
    s.onToolResult("a", false);
    nowMs = 11_000;
    const trip = await s.onToolCall({ toolCallId: "b", toolName: "write", input: {} });
    assert.equal(trip?.block, true);
  });

  it("onAgentEnd fires the checkpoint when the cadence became due mid-turn with no further calls", async () => {
    let nowMs = 0;
    const ui = fakeUi();
    const s = session(ui, {
      cfg: cfg({ checkpointSeconds: 10, maxChangesPerCheckpoint: 1000 }),
      now: () => nowMs,
    });
    const baseline = s.checkpoint!.getBaselineTime();
    nowMs = 11_000;
    await s.onAgentEnd();
    assert.notEqual(s.checkpoint!.getBaselineTime(), baseline);
    assert.match(ui.notifies.at(-1)?.message ?? "", /end of turn/);
  });
});

describe("pi-gate file-hash provenance", () => {
  it("a throwing fileStateHashesFn does not affect the count-based gate", async () => {
    const ui = fakeUi();
    const s = session(ui, {
      cfg: cfg({ maxChangesPerCheckpoint: 1 }),
      gitOk: () => true,
      fileStateHashesFn: () => {
        throw new Error("boom");
      },
    });
    await s.onToolCall({ toolCallId: "a", toolName: "write", input: { path: "a" } });
    s.onToolResult("a", false);
    const trip = await s.onToolCall({ toolCallId: "b", toolName: "write", input: { path: "b" } });
    assert.equal(trip?.block, true);
    assert.match(ui.notifies.at(-1)?.message ?? "", /── checkpoint ──/);
  });

  it("pre-existing dirty files are excluded from the first checkpoint's file list", async () => {
    const ui = fakeUi();
    const s = session(ui, {
      cfg: cfg({ maxChangesPerCheckpoint: 1 }),
      gitOk: () => true,
      fileStateHashesFn: () => new Map([["old.ts", "h1"]]),
    });
    const d = await s.onToolCall({ toolCallId: "1", toolName: "write", input: { path: "a" } });
    assert.equal(d, undefined);
    const trip = await s.onToolCall({ toolCallId: "2", toolName: "write", input: { path: "b" } });
    assert.equal(trip?.block, true);
    assert.ok(!ui.notifies.at(-1)?.message?.includes("old.ts"));
  });

  it("two consecutive checkpoints each list only the newly-touched file, never earlier ones", async () => {
    const ui = fakeUi();
    let hashes = new Map([["a.ts", "h-a"]]); // pre-existing dirty file before agent-driver started
    const s = session(ui, {
      cfg: cfg({ maxChangesPerCheckpoint: 1 }),
      gitOk: () => true,
      fileStateHashesFn: () => hashes,
    });

    // checkpoint 1: b.ts newly written
    hashes = new Map([
      ["a.ts", "h-a"],
      ["b.ts", "h-b"],
    ]);
    const d1 = await s.onToolCall({ toolCallId: "1", toolName: "write", input: { path: "a" } });
    assert.equal(d1, undefined);
    const trip1 = await s.onToolCall({ toolCallId: "2", toolName: "write", input: { path: "b" } });
    assert.equal(trip1?.block, true);
    const summary1 = ui.notifies.at(-1)?.message ?? "";
    assert.ok(summary1.includes("b.ts"), summary1);
    assert.ok(!summary1.includes("a.ts"), summary1);
    s.onTurnEnd();

    // checkpoint 2: c.ts newly written; a.ts/b.ts unchanged since checkpoint 1's reset
    hashes = new Map([
      ["a.ts", "h-a"],
      ["b.ts", "h-b"],
      ["c.ts", "h-c"],
    ]);
    const d2 = await s.onToolCall({ toolCallId: "3", toolName: "write", input: { path: "c" } });
    assert.equal(d2, undefined);
    const trip2 = await s.onToolCall({ toolCallId: "4", toolName: "write", input: { path: "d" } });
    assert.equal(trip2?.block, true);
    const summary2 = ui.notifies.at(-1)?.message ?? "";
    assert.ok(summary2.includes("c.ts"), summary2);
    assert.ok(!summary2.includes("a.ts"), summary2);
    assert.ok(!summary2.includes("b.ts"), summary2);
  });
});

describe("gitOk detection in real temp dir", () => {
  it("non-git temp dir falls back to off for human-driver mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-nongit-"));
    try {
      const ui = fakeUi();
      const s = createPearSession({
        cwd: dir,
        cfg: cfg({ mode: "human-driver" }),
        completions: { small: async () => "[]", large: async () => "[]" },
        ui,
        onFindings: () => {},
        sendUserMessage: () => {},
        saveConfig: () => {},
      });
      assert.equal(s.isGit, false);
      assert.equal(s.mode, "off");
      assert.equal(s.scheduler, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git temp dir enables the scheduler when both completions resolve", () => {
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
        cfg: cfg({ mode: "human-driver" }),
        completions: { small: async () => "[]", large: async () => "[]" },
        ui,
        onFindings: () => {},
        sendUserMessage: () => {},
        saveConfig: () => {},
      });
      assert.equal(s.isGit, true);
      assert.equal(s.mode, "human-driver");
      assert.ok(s.scheduler);
      assert.equal(s.checkpoint, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
