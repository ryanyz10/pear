import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.ts";
import type { Driver } from "../src/drive.ts";
import type { Scheduler, SchedulerState } from "../src/navigate.ts";
import { runSession, runTurn } from "../src/session.ts";
import { createUi } from "../src/ui.ts";
import type { Terminal } from "@earendil-works/pi-tui";

function stubScheduler(): Scheduler & { calls: string[] } {
  const calls: string[] = [];
  let parked = false;
  let state: SchedulerState = "IDLE";
  return {
    calls,
    notify() {},
    setAgentActive(active: boolean) {
      calls.push(`setAgentActive(${active})`);
      parked = active;
    },
    markReviewed(hash: string) {
      calls.push(`markReviewed(${hash})`);
    },
    getState: () => state,
    isParked: () => parked,
    getLatestHash: () => "",
    getReviewed: () => new Set(),
    getLastSummary: () => "none",
    stop() {
      calls.push("stop");
    },
  };
}

function stubDriver(promptImpl: (task: string) => Promise<void>): Driver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prompt: async (task: string) => {
      calls.push(`prompt(${task})`);
      await promptImpl(task);
    },
    abort() {
      calls.push("abort");
    },
  };
}

function stubUi(): {
  ui: RunTurnUi;
  calls: string[];
  findings: string[];
} {
  const calls: string[] = [];
  const findings: string[] = [];
  return {
    calls,
    findings,
    ui: {
      setBusy(b: boolean) {
        calls.push(`setBusy(${b})`);
      },
      appendFindings(t: string) {
        calls.push(`appendFindings`);
        findings.push(t);
      },
      flush() {
        calls.push("flush");
      },
    },
  };
}

type RunTurnUi = { setBusy(b: boolean): void; appendFindings(t: string): void; flush(): void };

describe("runTurn lifecycle", () => {
  it("orders park → busy → prompt → mark → unpark → busy-off → flush; re-entrant", async () => {
    const scheduler = stubScheduler();
    const driver = stubDriver(async () => {});
    const { ui, calls: uiCalls } = stubUi();

    await runTurn(
      { scheduler, driver, ui, stateHash: () => "h1", isGit: true },
      "task-a",
    );
    await runTurn(
      { scheduler, driver, ui, stateHash: () => "h2", isGit: true },
      "task-b",
    );

    assert.deepEqual(
      [...scheduler.calls.filter((c) => c.startsWith("setAgent") || c.startsWith("mark")), ...[]],
      [
        "setAgentActive(true)",
        "markReviewed(h1)",
        "setAgentActive(false)",
        "setAgentActive(true)",
        "markReviewed(h2)",
        "setAgentActive(false)",
      ],
    );
    assert.deepEqual(driver.calls, ["prompt(task-a)", "prompt(task-b)"]);
    assert.deepEqual(uiCalls, [
      "setBusy(true)",
      "setBusy(false)",
      "flush",
      "setBusy(true)",
      "setBusy(false)",
      "flush",
    ]);
  });

  it("rejected prompt still cleans up and reports error", async () => {
    const scheduler = stubScheduler();
    const driver = stubDriver(async () => {
      throw new Error("boom");
    });
    const { ui, calls: uiCalls, findings } = stubUi();

    await runTurn(
      { scheduler, driver, ui, stateHash: () => "h", isGit: true },
      "fail",
    );
    assert.ok(findings.some((f) => /boom/.test(f)));
    assert.ok(scheduler.calls.includes("setAgentActive(false)"));
    assert.ok(uiCalls.includes("setBusy(false)"));
    assert.ok(uiCalls.includes("flush"));

    // subsequent turn re-enters cleanly
    const driver2 = stubDriver(async () => {});
    await runTurn(
      { scheduler, driver: driver2, ui, stateHash: () => "h2", isGit: true },
      "ok",
    );
    assert.ok(driver2.calls.includes("prompt(ok)"));
  });

  it("throwing stateHash still unparks / busy-off / flush", async () => {
    const scheduler = stubScheduler();
    const driver = stubDriver(async () => {});
    const { ui, calls: uiCalls } = stubUi();

    await runTurn(
      {
        scheduler,
        driver,
        ui,
        stateHash: () => {
          throw new Error("git down");
        },
        isGit: true,
      },
      "t",
    );
    assert.ok(scheduler.calls.includes("setAgentActive(false)"));
    assert.ok(!scheduler.calls.some((c) => c.startsWith("markReviewed")));
    assert.ok(uiCalls.includes("setBusy(false)"));
    assert.ok(uiCalls.includes("flush"));
  });
});

function fakeTerminal(): Terminal & { feed: (d: string) => void; stopCount: number } {
  let onInput: ((data: string) => void) | null = null;
  let stopCount = 0;
  const t: Terminal & { feed: (d: string) => void; stopCount: number } = {
    stopCount: 0,
    feed(data: string) {
      onInput?.(data);
    },
    start(input) {
      onInput = input;
    },
    stop() {
      stopCount++;
      t.stopCount = stopCount;
      onInput = null;
    },
    async drainInput() {},
    write() {},
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  return t;
}

describe("runSession shutdown", () => {
  it("terminal.stop precedes exit; process does not exit", async () => {
    const term = fakeTerminal();
    const order: string[] = [];
    const origStop = term.stop.bind(term);
    term.stop = () => {
      order.push("terminal.stop");
      origStop();
    };

    const cfg: Config = {
      cwd: process.cwd(),
      driveModel: "openai/gpt-4o-mini",
      navModel: "openai/gpt-4o-mini",
      pauseLines: 150,
      pauseEdits: 5,
      minLines: 50,
      debounceSeconds: 10,
      intervalSeconds: 60,
      noNav: true,
      isGit: false,
    };

    const done = runSession(cfg, {
      createUi: (opts) => createUi({ ...opts, terminal: term }),
      exit: (code) => {
        order.push(`exit:${code}`);
      },
    });

    // Let start() wire input, then submit /quit
    await new Promise((r) => setImmediate(r));
    for (const ch of "/quit") term.feed(ch);
    term.feed("\r");
    await done;

    assert.deepEqual(order, ["terminal.stop", "exit:0"]);
    assert.equal(term.stopCount, 1);
  });
});
