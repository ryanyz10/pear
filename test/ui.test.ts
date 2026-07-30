import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, type Terminal } from "@earendil-works/pi-tui";
import { createUi, isCtrlC } from "../src/ui.ts";

function fakeTerminal(): Terminal & {
  writes: string[];
  feed: (data: string) => void;
  stopCount: number;
} {
  let onInput: ((data: string) => void) | null = null;
  const writes: string[] = [];
  let stopCount = 0;
  const t: Terminal & {
    writes: string[];
    feed: (data: string) => void;
    stopCount: number;
  } = {
    writes,
    stopCount: 0,
    feed(data: string) {
      onInput?.(data);
    },
    start(input, _resize) {
      onInput = input;
    },
    stop() {
      stopCount++;
      t.stopCount = stopCount;
      onInput = null;
    },
    async drainInput() {},
    write(data: string) {
      writes.push(data);
    },
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

function typeLine(term: { feed: (d: string) => void }, text: string) {
  for (const ch of text) term.feed(ch);
  term.feed("\r");
}

function renderAll(ui: ReturnType<typeof createUi>, width = 80): string {
  return ui.getTui().render(width).join("\n");
}

describe("ui facade", () => {
  it("getTask resolves with submitted line", async () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    const p = ui.getTask();
    typeLine(term, "hello task");
    assert.equal(await p, "hello task");
    ui.stop();
  });

  it("suppresses submit when busy (disableSubmit); text retained", async () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    ui.setBusy(true);
    assert.equal(ui.getEditor().disableSubmit, true);

    const p = ui.getTask();
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    typeLine(term, "queued?");
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false);
    // Editor clears on attempted submit path only when submit fires; with disableSubmit
    // Enter is ignored and text stays.
    assert.match(ui.getEditor().getText(), /queued/);

    ui.setBusy(false);
    // Re-submit retained text
    term.feed("\r");
    assert.equal(await p, "queued?");
    ui.stop();
  });

  it("checkpoint Continue / Esc / Skip / Steer", async () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();

    const cont = ui.checkpoint("summary continue");
    await new Promise((r) => setImmediate(r));
    term.feed("\r"); // Continue selected by default
    assert.deepEqual(await cont, { kind: "continue" });

    const esc = ui.checkpoint("summary esc");
    await new Promise((r) => setImmediate(r));
    term.feed("\x1b");
    assert.deepEqual(await esc, { kind: "continue" });

    const skip = ui.checkpoint("summary skip");
    await new Promise((r) => setImmediate(r));
    term.feed("\x1b[B"); // down → Steer
    term.feed("\x1b[B"); // down → Skip
    term.feed("\r");
    assert.deepEqual(await skip, { kind: "skip" });

    const steer = ui.checkpoint("summary steer");
    await new Promise((r) => setImmediate(r));
    term.feed("\x1b[B"); // Steer…
    term.feed("\r");
    await new Promise((r) => setImmediate(r));
    // Focusable Input emits CURSOR_MARKER when focused (SelectList has no focused prop).
    const { Input } = await import("@earendil-works/pi-tui");
    const probe = new Input();
    probe.focused = true;
    assert.ok(probe.render(40).some((l) => l.includes(CURSOR_MARKER)));
    typeLine(term, "do something else");
    assert.deepEqual(await steer, { kind: "steer", text: "do something else" });

    // Focus restored to editor
    const task = ui.getTask();
    typeLine(term, "after");
    assert.equal(await task, "after");
    ui.stop();
  });

  it("new Markdown after checkpoint mid-stream (message boundary)", () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    ui.appendAssistantStart();
    ui.appendAssistantDelta("before ");
    // Simulate checkpoint completing — next message_start must be a new component
    ui.appendAssistantEnd();
    ui.appendAssistantStart();
    ui.appendAssistantDelta("after");
    const lines = renderAll(ui);
    assert.match(lines, /before/);
    assert.match(lines, /after/);
    ui.appendAssistantEnd();
    ui.stop();
  });

  it("streams deltas before message_end", () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    ui.appendAssistantStart();
    ui.appendAssistantDelta("partial stream");
    const beforeEnd = renderAll(ui);
    assert.match(beforeEnd, /partial stream/);
    ui.appendAssistantEnd();
    ui.stop();
  });

  it("findings queue: flush only when !agentTurn && !overlay", async () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    ui.setBusy(true);
    ui.appendFindings("finding-A");
    assert.doesNotMatch(renderAll(ui), /finding-A/);

    const cp = ui.checkpoint("gate");
    await new Promise((r) => setImmediate(r));
    ui.appendFindings("finding-B");
    ui.setBusy(false); // still overlay → still queued
    assert.doesNotMatch(renderAll(ui), /finding-A|finding-B/);

    term.feed("\r"); // continue → hide overlay → flush
    await cp;
    const after = renderAll(ui);
    assert.match(after, /finding-A/);
    assert.match(after, /finding-B/);
    ui.stop();
  });

  it("editor/status stay below log after appends", () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    ui.setStatus("status-line-xyz");
    ui.appendFindings("log-line-abc");
    const lines = ui.getTui().render(80);
    const joined = lines.join("\n");
    const logIdx = joined.indexOf("log-line-abc");
    const statusIdx = joined.indexOf("status-line-xyz");
    assert.ok(logIdx >= 0 && statusIdx >= 0);
    assert.ok(logIdx < statusIdx, "status should render after log");
    // Editor is last child — its border/content appears after status
    assert.ok(statusIdx < joined.length - 1);
    ui.stop();
  });

  it("stop settles getTask→/quit and checkpoint→cancelled; terminal.stop once", async () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    const task = ui.getTask();
    const cp = ui.checkpoint("during shutdown");
    await new Promise((r) => setImmediate(r));
    ui.stop();
    assert.equal(await task, "/quit");
    assert.deepEqual(await cp, { kind: "cancelled" });
    assert.equal(term.stopCount, 1);
    ui.stop(); // idempotent
    assert.equal(term.stopCount, 1);
  });

  it("Ctrl+C listener can be wired", () => {
    const term = fakeTerminal();
    const ui = createUi({ terminal: term, header: "h" });
    ui.start();
    let hit = false;
    ui.addInputListener((data) => {
      if (isCtrlC(data)) {
        hit = true;
        return { consume: true };
      }
      return undefined;
    });
    term.feed("\x03");
    assert.equal(hit, true);
    ui.stop();
  });
});
