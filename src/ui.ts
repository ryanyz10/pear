import {
  Container,
  Editor,
  Input,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  matchesKey,
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
} from "@earendil-works/pi-tui";
import { editorTheme, markdownTheme, selectTheme, dim, dimCyan } from "./theme.ts";

export type CheckpointResult =
  | { kind: "continue" }
  | { kind: "skip" }
  | { kind: "steer"; text: string }
  | { kind: "cancelled" };

export type CreateUiOpts = {
  terminal?: Terminal;
  header?: string;
};

export type Ui = {
  start(): void;
  stop(): void;
  getTask(): Promise<string>;
  checkpoint(summary: string): Promise<CheckpointResult>;
  appendAssistantStart(): void;
  appendAssistantDelta(d: string): void;
  appendAssistantEnd(): void;
  appendTool(name: string, hint: string): void;
  appendFindings(text: string): void;
  setStatus(text: string): void;
  setBusy(agentTurn: boolean): void;
  flush(): void;
  addInputListener(
    listener: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getTui(): TUI;
  getEditor(): Editor;
  getTerminal(): Terminal;
};

/** Focusable overlay: summary + SelectList, or steering Input. */
class CheckpointOverlay implements Component, Focusable {
  focused = false;
  private summary: Text;
  private list: SelectList;
  private input: Input | null = null;
  private mode: "list" | "steer" = "list";
  private onDone: (r: CheckpointResult) => void;
  private requestRender: () => void;

  constructor(
    summary: string,
    onDone: (r: CheckpointResult) => void,
    requestRender: () => void,
  ) {
    this.summary = new Text(summary, 1, 0);
    this.onDone = onDone;
    this.requestRender = requestRender;
    this.list = new SelectList(
      [
        { value: "continue", label: "Continue", description: "execute the gated action" },
        { value: "steer", label: "Steer…", description: "redirect; do not execute" },
        { value: "skip", label: "Skip", description: "skip this action" },
      ],
      5,
      selectTheme,
    );
    this.list.onSelect = (item) => this.onSelect(item);
    this.list.onCancel = () => this.finish({ kind: "continue" });
  }

  private onSelect(item: SelectItem): void {
    if (item.value === "continue") {
      this.finish({ kind: "continue" });
      return;
    }
    if (item.value === "skip") {
      this.finish({ kind: "skip" });
      return;
    }
    // Steer… → swap to Input
    this.mode = "steer";
    this.input = new Input();
    this.input.focused = true;
    this.input.onSubmit = (value) => {
      const text = value.trim();
      this.finish(text ? { kind: "steer", text } : { kind: "continue" });
    };
    this.input.onEscape = () => {
      this.mode = "list";
      this.input = null;
      this.requestRender();
    };
    this.requestRender();
  }

  private finish(r: CheckpointResult): void {
    this.onDone(r);
  }

  handleInput(data: string): void {
    if (this.mode === "steer" && this.input) {
      this.input.focused = true;
      this.input.handleInput(data);
      this.requestRender();
      return;
    }
    this.list.handleInput(data);
    this.requestRender();
  }

  invalidate(): void {
    this.summary.invalidate();
    this.list.invalidate();
    this.input?.invalidate();
  }

  render(width: number): string[] {
    const lines = [...this.summary.render(width), ""];
    if (this.mode === "steer" && this.input) {
      this.input.focused = true;
      lines.push("steering:", ...this.input.render(width));
    } else {
      lines.push(...this.list.render(width));
    }
    return lines;
  }
}

export function createUi(opts: CreateUiOpts = {}): Ui {
  const terminal = opts.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const log = new Container();
  const header = new Text(
    opts.header ??
      "pear — pair programming\n  type a task to drive; edit files for navigator reviews\n  /status  /quit",
    0,
    0,
  );
  const statusText = new Text("ready", 0, 0);
  const editor = new Editor(tui, editorTheme);

  let agentTurn = false;
  let overlayOpen = false;
  let stopped = false;
  let currentMd: Markdown | null = null;
  let currentAcc = "";
  const findingsQueue: string[] = [];
  const pendingTasks: string[] = [];
  const taskWaiters: Array<(s: string) => void> = [];
  let overlayHandle: OverlayHandle | null = null;
  let checkpointResolve: ((r: CheckpointResult) => void) | null = null;

  const busy = () => agentTurn || overlayOpen;

  const syncSubmit = () => {
    editor.disableSubmit = busy() || stopped;
  };

  const appendLogChild = (c: Component) => {
    log.addChild(c);
    tui.requestRender();
  };

  const appendLogText = (text: string) => {
    if (!text) return;
    appendLogChild(new Text(text.replace(/\n$/, ""), 0, 0));
  };

  const flush = () => {
    if (busy() || stopped) return;
    while (findingsQueue.length) appendLogText(findingsQueue.shift()!);
  };

  const resolveCheckpoint = (r: CheckpointResult) => {
    const resolve = checkpointResolve;
    checkpointResolve = null;
    overlayOpen = false;
    syncSubmit();
    if (overlayHandle) {
      try {
        overlayHandle.hide();
      } catch {
        /* */
      }
      overlayHandle = null;
    }
    tui.setFocus(editor);
    tui.requestRender();
    flush();
    resolve?.(r);
  };

  editor.onSubmit = (text) => {
    if (editor.disableSubmit || stopped) return;
    const t = text.trim();
    if (!t) return;
    editor.setText("");
    editor.addToHistory(t);
    if (taskWaiters.length) taskWaiters.shift()!(t);
    else pendingTasks.push(t);
  };

  return {
    start() {
      tui.addChild(header);
      tui.addChild(log);
      tui.addChild(statusText);
      tui.addChild(editor);
      tui.start();
      tui.setFocus(editor);
      tui.requestRender();
    },

    stop() {
      if (stopped) return;
      stopped = true;
      syncSubmit();
      while (taskWaiters.length) taskWaiters.shift()!("/quit");
      if (checkpointResolve) resolveCheckpoint({ kind: "cancelled" });
      tui.stop();
    },

    getTask() {
      if (stopped) return Promise.resolve("/quit");
      if (pendingTasks.length) return Promise.resolve(pendingTasks.shift()!);
      return new Promise<string>((resolve) => {
        taskWaiters.push(resolve);
      });
    },

    checkpoint(summary: string) {
      if (stopped) return Promise.resolve({ kind: "cancelled" as const });
      return new Promise<CheckpointResult>((resolve) => {
        checkpointResolve = resolve;
        overlayOpen = true;
        syncSubmit();
        const overlay = new CheckpointOverlay(summary, resolveCheckpoint, () => tui.requestRender());
        overlayHandle = tui.showOverlay(overlay, { width: "80%", maxHeight: "60%", anchor: "center" });
        tui.requestRender();
      });
    },

    appendAssistantStart() {
      currentAcc = "";
      currentMd = new Markdown("", 0, 0, markdownTheme);
      appendLogChild(currentMd);
    },

    appendAssistantDelta(d: string) {
      if (!currentMd) {
        // Defensive: treat orphan delta as a new message.
        this.appendAssistantStart();
      }
      currentAcc += d;
      currentMd!.setText(currentAcc);
      tui.requestRender();
    },

    appendAssistantEnd() {
      currentMd = null;
      currentAcc = "";
    },

    appendTool(name: string, hint: string) {
      appendLogText(dimCyan(`→ ${name}${hint}`));
    },

    appendFindings(text: string) {
      if (stopped) return;
      if (busy()) findingsQueue.push(dim(text));
      else appendLogText(dim(text));
    },

    setStatus(text: string) {
      statusText.setText(text);
      tui.requestRender();
    },

    setBusy(b: boolean) {
      agentTurn = b;
      syncSubmit();
      if (!b) flush();
    },

    flush,

    addInputListener(listener) {
      return tui.addInputListener(listener);
    },

    getTui: () => tui,
    getEditor: () => editor,
    getTerminal: () => terminal,
  };
}

/** Convenience: detect Ctrl+C for shutdown wiring. */
export function isCtrlC(data: string): boolean {
  return matchesKey(data, "ctrl+c");
}
