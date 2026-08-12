import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import pear from "../adapters/pi/extensions/pear.ts";
import { saveConfig, type PearConfig } from "../core/config.ts";

/* ------------------------------------------------------------------ fakes */

type Handler = (event: any, ctx: any) => any;
type ToolDef = {
  name: string;
  description: string;
  executionMode?: string;
  execute: (
    id: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: any,
  ) => Promise<any>;
  renderCall?: (args: any, theme: any) => unknown;
  renderResult?: (result: any, options: any, theme: any) => unknown;
};

type Notification = { message: string; type?: string };
type Entry = { type: "custom"; customType: string; data?: unknown };

const BUILTINS = ["bash", "read", "edit", "write", "grep", "find", "ls"];

function fakePi(entries: Entry[], extraTools: string[]) {
  const sentUserMessages: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDef>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: any) => Promise<void> }
  >();
  let active = [...BUILTINS, ...extraTools];
  const toolSetCalls: string[][] = [];

  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (tool: ToolDef) => {
      tools.set(tool.name, tool);
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    registerEntryRenderer: () => {},
    registerMessageRenderer: () => {},
    appendEntry: (customType: string, data?: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: (content: string) => sentUserMessages.push(content),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
      toolSetCalls.push([...names]);
    },
    getAllTools: () => active.map((name) => ({ name })),
  };

  const emit = async (event: string, payload: unknown, ctx: unknown) => {
    const results = [];
    for (const h of handlers.get(event) ?? []) results.push(await h(payload, ctx));
    return results;
  };

  return {
    api,
    emit,
    tools,
    commands,
    handlers,
    sentUserMessages,
    activeTools: () => [...active],
    toolSetCalls,
  };
}

type CtxOptions = {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  /** Answer for ui.custom (TUI card). */
  cardAnswer?: unknown;
  /** Answers for ui.select, consumed in order (RPC path). */
  selectAnswers?: (string | undefined)[];
  inputAnswer?: string | undefined;
  customThrows?: Error;
  entries?: Entry[];
  /** Agent busy? The auto-trigger refuses to start a turn mid-stream. */
  idle?: boolean;
  /** Half-typed message in the editor; the auto-trigger refuses to bury it. */
  editorText?: string;
};

function fakeCtx(opts: CtxOptions) {
  let editorText = opts.editorText ?? "";
  let idle = opts.idle ?? true;
  const notifications: Notification[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const widgets: Array<[string, string[] | undefined]> = [];
  const queue = [...(opts.selectAnswers ?? [])];
  let abortCalls = 0;

  const mode = opts.mode ?? "tui";
  const ctx = {
    cwd: opts.cwd,
    mode,
    hasUI: opts.hasUI ?? (mode !== "print" && mode !== "json"),
    signal: undefined as AbortSignal | undefined,
    sessionManager: { getEntries: () => opts.entries ?? [] },
    isIdle: () => idle,
    abort: () => {
      abortCalls++;
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (k: string, t: string | undefined) => statuses.push([k, t]),
      custom: async (_factory: unknown) => {
        if (opts.customThrows) throw opts.customThrows;
        return opts.cardAnswer ?? null;
      },
      select: async (title: string, options: string[]) => {
        selects.push({ title, options });
        return queue.shift();
      },
      input: async (_title: string) => opts.inputAnswer,
      getEditorText: () => editorText,
      setWidget: (key: string, content: string[] | undefined) => widgets.push([key, content]),
    },
  };

  return {
    ctx,
    notifications,
    statuses,
    selects,
    widgets,
    abortCalls: () => abortCalls,
    /** The human finished (or abandoned) what they were typing. */
    setEditorText: (text: string) => {
      editorText = text;
    },
    /** The agent's turn ended. */
    setIdle: (next: boolean) => {
      idle = next;
    },
  };
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pear-life-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  // pear's own config lives in the tree; ignoring it is what real projects do,
  // and without it every human-driver measurement counts .pear/config.json as
  // a change the human made.
  writeFileSync(join(dir, ".gitignore"), ".pear/\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

type BootOptions = Omit<CtxOptions, "cwd"> & {
  cwd?: string;
  config?: PearConfig;
  extraTools?: string[];
};

/**
 * Stands in for setInterval plus the clock, so the poll loop can be driven,
 * counted, and pushed past the watcher's debounce deterministically.
 */
function fakeTimers() {
  const live = new Set<{ fn: () => void; ms: number }>();
  let started = 0;
  let clock = 0;
  return {
    started: () => started,
    liveCount: () => live.size,
    /** Run every live interval, advancing the clock by its period each time. */
    poll: (times = 1) => {
      for (let i = 0; i < times; i++) {
        for (const t of [...live]) {
          clock += t.ms;
          t.fn();
        }
      }
    },
    hooks: {
      setInterval: (fn: () => void, ms: number) => {
        started++;
        const handle = { fn, ms, unref: () => {} };
        live.add(handle);
        return handle;
      },
      clearInterval: (handle: never) => {
        live.delete(handle as unknown as { fn: () => void; ms: number });
      },
      now: () => clock,
    },
  };
}

/**
 * Boot the extension and return everything needed to drive it.
 *
 * `planPhase` defaults to false so tests can exercise the build loop directly;
 * the scoping tests turn it on explicitly.
 */
async function boot(opts: BootOptions = {}) {
  const cwd = opts.cwd ?? tempRepo();
  const config: PearConfig = { planPhase: false, ...opts.config };
  saveConfig(cwd, config);

  const entries = opts.entries ?? [];
  const pi = fakePi(entries, opts.extraTools ?? []);
  const timers = fakeTimers();
  pear(pi.api as never, timers.hooks);
  const c = fakeCtx({ ...opts, cwd, entries });
  await pi.emit("session_start", { reason: "startup" }, c.ctx);
  return { ...pi, ...c, cwd, entries, timers };
}

const driver = (extra: PearConfig = {}): BootOptions => ({
  config: { mode: "agent-driver", ...extra },
});

/** A write costing 40 + `lines` points. */
const writeCall = (id: string, path: string, lines = 0) => ({
  toolCallId: id,
  toolName: "write",
  input: { path, content: Array.from({ length: lines }, (_, i) => `l${i}`).join("\n") },
});

const PLAN_ARGS = { summary: "Do the thing.", steps: ["First", "Second"] };

/* ------------------------------------------------------------------ tests */

describe("registration", () => {
  it("registers all three tools and every command", async () => {
    const b = await boot(driver());
    for (const tool of ["pear_ask", "pear_plan", "pear_checkpoint"]) {
      assert.ok(b.tools.has(tool), `missing ${tool}`);
      assert.equal(b.tools.get(tool)?.executionMode, "sequential", tool);
    }
    for (const cmd of [
      "pear",
      "pear-plan",
      "pear-status",
      "pear-checkpoint",
      "pear-exclusive",
      "pear-mode",
      "pear-config",
    ]) {
      assert.ok(b.commands.has(cmd), `missing /${cmd}`);
    }
  });

  it("registers the tools even in off mode (pi cannot unregister)", async () => {
    const b = await boot({ config: { mode: "off" } });
    assert.ok(b.tools.has("pear_checkpoint"));
  });
});

describe("persona injection", () => {
  it("adds the scoping persona before a plan is approved", async () => {
    const b = await boot(driver({ planPhase: true }));
    const [result] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.match(result.systemPrompt, /^BASE/);
    assert.match(result.systemPrompt, /discover before you build/i);
    assert.match(result.systemPrompt, /pear_plan/);
  });

  it("adds the driver persona once building, carrying the plan verbatim", async () => {
    const b = await boot(driver({ planPhase: true }));
    await approvePlan(b);
    const [result] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.match(result.systemPrompt, /you are the driver/i);
    assert.match(result.systemPrompt, /Do the thing\./);
    assert.match(result.systemPrompt, /1\. First/);
  });

  it("the driver persona names open questions so the agent does not guess", async () => {
    const b = await boot(driver({ planPhase: true }));
    (b.ctx.ui as any).custom = async () => ({ kind: "approve" });
    await b.tools
      .get("pear_plan")
      ?.execute("p", { ...PLAN_ARGS, openQuestions: ["Timeout value?"] }, undefined, undefined, b.ctx);
    const [result] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.match(result.systemPrompt, /open questions/);
    assert.match(result.systemPrompt, /Timeout value\?/);
  });

  it("leaves the prompt alone in off mode", async () => {
    const off = await boot({ config: { mode: "off" } });
    const [result] = await off.emit("before_agent_start", { systemPrompt: "BASE" }, off.ctx);
    assert.equal(result, undefined);
  });
});

async function approvePlan(b: Awaited<ReturnType<typeof boot>>) {
  (b.ctx.ui as any).custom = async () => ({ kind: "approve" });
  return await b.tools.get("pear_plan")?.execute("p", PLAN_ARGS, undefined, undefined, b.ctx);
}

describe("headless policy", () => {
  it("fails closed to off when there is no dialog-capable UI", async () => {
    const b = await boot({ ...driver(), mode: "print", hasUI: false });
    const [result] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.equal(result, undefined, "no persona: pear is off for this session");
    assert.ok(
      b.notifications.some((n) => /needs an interactive session/.test(n.message)),
      "should explain why",
    );
  });

  it("does not rewrite the config when failing closed", async () => {
    const cwd = tempRepo();
    await boot({ cwd, ...driver(), mode: "print", hasUI: false });
    const onDisk = JSON.parse(readFileSync(join(cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.mode, "agent-driver", "user's config must be preserved");
  });

  it("/pear-mode agent-driver saves but does not claim to be running", async () => {
    const b = await boot({ config: { mode: "off" }, mode: "print", hasUI: false });
    await b.commands.get("pear-mode")?.handler("agent-driver", b.ctx);

    const onDisk = JSON.parse(readFileSync(join(b.cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.mode, "agent-driver");

    assert.ok(
      b.notifications.some(
        (n) => n.type === "warning" && /needs an interactive session/.test(n.message),
      ),
    );

    const [prompt] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.equal(prompt, undefined, "must not run agent-driver without a human");
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.equal(decision, undefined);
  });
});

describe("legacy config", () => {
  it("reads a config with unknown keys without ever writing to it", async () => {
    // Byte-identity on load is the property worth keeping. human-driver used
    // to be the deferred mode standing in for it; it runs now, so an unknown
    // key plays that part instead.
    const cwd = tempRepo();
    const raw = JSON.stringify({ mode: "agent-driver", reviewModel: "a/b" }, null, 2) + "\n";
    mkdirSync(join(cwd, ".pear"), { recursive: true });
    writeFileSync(join(cwd, ".pear", "config.json"), raw);

    const pi = fakePi([], []);
    pear(pi.api as never);
    const c = fakeCtx({ cwd });
    await pi.emit("session_start", { reason: "startup" }, c.ctx);

    assert.equal(readFileSync(join(cwd, ".pear", "config.json"), "utf8"), raw, "file untouched");
  });

  it("explains the new budget units when migrating the old key", async () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".pear"), { recursive: true });
    writeFileSync(
      join(cwd, ".pear", "config.json"),
      JSON.stringify({ mode: "agent-driver", maxChangesPerCheckpoint: 5 }),
    );

    const pi = fakePi([], []);
    pear(pi.api as never);
    const c = fakeCtx({ cwd });
    await pi.emit("session_start", { reason: "startup" }, c.ctx);

    assert.ok(c.notifications.some((n) => /reviewBudget=200/.test(n.message)));
  });
});

describe("the gate hook", () => {
  it("blocks an over-budget call without aborting the run", async () => {
    const b = await boot(driver({ reviewBudget: 200 }));
    await b.emit("tool_call", writeCall("big", "big.ts", 400), b.ctx);
    const [decision] = await b.emit("tool_call", writeCall("next", "f.ts", 1), b.ctx);

    assert.equal(decision.block, true);
    assert.match(decision.reason, /checkpoint overdue/);
    assert.equal(b.abortCalls(), 0, "ctx.abort() must never be called");
  });

  it("passes non-mutating tools straight through", async () => {
    const b = await boot(driver());
    const [decision] = await b.emit(
      "tool_call",
      { toolCallId: "r", toolName: "read", input: { path: "f" } },
      b.ctx,
    );
    assert.equal(decision, undefined);
  });

  it("lets a small run of edits to one file through", async () => {
    const b = await boot(driver({ reviewBudget: 200 }));
    for (let i = 0; i < 5; i++) {
      const [decision] = await b.emit("tool_call", writeCall(`c${i}`, "same.ts", 2), b.ctx);
      assert.equal(decision, undefined, `edit ${i + 1}`);
    }
  });
});

describe("the tool_result nag", () => {
  const settle = (b: Awaited<ReturnType<typeof boot>>, id: string, content: unknown[]) =>
    b.emit("tool_result", { toolCallId: id, toolName: "write", isError: false, content }, b.ctx);

  it("says nothing while the load is low", async () => {
    const b = await boot(driver({ reviewBudget: 200 }));
    await b.emit("tool_call", writeCall("a", "a.ts", 5), b.ctx);
    const [result] = await settle(b, "a", [{ type: "text", text: "wrote a.ts" }]);
    assert.equal(result, undefined);
  });

  it("appends a note past the soft fraction", async () => {
    const b = await boot(driver({ reviewBudget: 200 }));
    await b.emit("tool_call", writeCall("a", "a.ts", 100), b.ctx);
    const [result] = await settle(b, "a", [{ type: "text", text: "wrote a.ts" }]);
    assert.match(result.content.at(-1).text, /look for a good place to check in/);
  });

  it("PRESERVES the original content blocks byte-identically", async () => {
    // `content` REPLACES what the model sees. Dropping the original would
    // silently blind the model to its own tool output.
    const b = await boot(driver({ reviewBudget: 200 }));
    const original = [
      { type: "text", text: "line one\nline two" },
      { type: "text", text: "second block" },
    ];
    await b.emit("tool_call", writeCall("a", "a.ts", 400), b.ctx);
    const [result] = await settle(b, "a", original);

    assert.equal(result.content.length, original.length + 1);
    assert.deepEqual(result.content.slice(0, original.length), original);
    assert.match(result.content.at(-1).text, /before the next edit/);
  });

  it("says nothing about a call it never admitted", async () => {
    const b = await boot(driver());
    const [result] = await settle(b, "never-admitted", [{ type: "text", text: "x" }]);
    assert.equal(result, undefined);
  });
});

describe("stop latch and input provenance", () => {
  async function stopIt(b: Awaited<ReturnType<typeof boot>>) {
    await b.tools
      .get("pear_checkpoint")
      ?.execute("t1", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
  }

  it("extension-injected messages do NOT clear a stop", async () => {
    const b = await boot({ ...driver(), cardAnswer: { kind: "stop" } });
    await stopIt(b);

    await b.emit("input", { text: "go on", source: "extension" }, b.ctx);
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.equal(decision?.block, true, "an extension must not be able to override the human");
  });

  it("real user input clears a stop", async () => {
    const b = await boot({ ...driver(), cardAnswer: { kind: "stop" } });
    await stopIt(b);

    await b.emit("input", { text: "carry on", source: "interactive" }, b.ctx);
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.equal(decision, undefined);
  });
});

describe("checkpoint tool — TUI", () => {
  const run = (b: Awaited<ReturnType<typeof boot>>, files: string[] = []) =>
    b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "did a thing", files, next: "next thing" }, undefined, undefined, b.ctx);

  it("keep going returns the continue result and does not terminate", async () => {
    const b = await boot({ ...driver(), cardAnswer: { kind: "continue" } });
    const res = await run(b, ["a.ts"]);
    assert.match(res.content[0].text, /NAVIGATOR: keep going/);
    assert.notEqual(res.terminate, true);
    assert.equal(res.details.answer, "continue");
  });

  it("change direction passes the human's words through verbatim", async () => {
    const b = await boot({
      ...driver(),
      cardAnswer: { kind: "steer", text: "use a Map, not an object" },
    });
    const res = await run(b);
    assert.match(res.content[0].text, /NAVIGATOR STEERING: use a Map, not an object/);
    assert.notEqual(res.terminate, true);
  });

  it("stop terminates the agent loop", async () => {
    const b = await boot({ ...driver(), cardAnswer: { kind: "stop" } });
    const res = await run(b);
    assert.match(res.content[0].text, /NAVIGATOR: stop/);
    assert.equal(res.terminate, true);
  });

  it("walk me through a file returns an instruction without terminating", async () => {
    const b = await boot({ ...driver(), cardAnswer: { kind: "explain", file: "a.ts" } });
    const res = await run(b, ["a.ts"]);
    assert.match(res.content[0].text, /walk me through/);
    assert.match(res.content[0].text, /a\.ts/);
    assert.notEqual(res.terminate, true, "the agent must stay free to explain");
    assert.equal(res.details.answer, "explain");

    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.match(decision?.reason ?? "", /is reviewing/);
  });

  it("the card comes back after a walkthrough, and clears the hold", async () => {
    const b = await boot({ ...driver(), cardAnswer: { kind: "explain", file: "a.ts" } });
    await run(b, ["a.ts"]);

    (b.ctx.ui as any).custom = async () => ({ kind: "continue" });
    const second = await run(b, ["a.ts"]);
    assert.match(second.content[0].text, /keep going/);
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.equal(decision, undefined, "editing resumes");
  });

  it("dismissing pauses changes without acknowledging them", async () => {
    const b = await boot({ ...driver(), cardAnswer: null });
    const res = await run(b);
    assert.match(res.content[0].text, /no answer/);
    assert.equal(res.terminate, true);
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.match(decision?.reason ?? "", /stepped away/);
  });

  it("shows the git-derived file list, not just what the agent claimed", async () => {
    const cwd = tempRepo();
    const b = await boot({ cwd, ...driver(), mode: "rpc", selectAnswers: ["Keep going"] });
    writeFileSync(join(cwd, "changed.txt"), "new content\n");

    await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: ["lied-about.txt"], next: "n" }, undefined, undefined, b.ctx);

    // The dialog path renders the same spec the TUI card would.
    const shown = b.notifications.map((n) => n.message).join("\n");
    assert.match(shown, /changed \(1\)/);
    assert.match(shown, /changed\.txt/, "git's list is what the human sees first");
    assert.match(shown, /also reported by the agent/);
    assert.match(shown, /lied-about\.txt/, "an uncorroborated claim is called out");
  });
});

describe("checkpoint tool — RPC", () => {
  const rpc = (answers: (string | undefined)[], inputAnswer?: string) => ({
    ...driver(),
    mode: "rpc" as const,
    selectAnswers: answers,
    inputAnswer,
  });

  const run = (b: Awaited<ReturnType<typeof boot>>, files: string[] = []) =>
    b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files, next: "n" }, undefined, undefined, b.ctx);

  it("uses dialogs and can keep going", async () => {
    const b = await boot(rpc(["Keep going"]));
    const res = await run(b);
    assert.match(res.content[0].text, /NAVIGATOR: keep going/);
  });

  it("collects steering text via the input dialog", async () => {
    const b = await boot(rpc(["Change direction…"], "try the other approach"));
    const res = await run(b);
    assert.match(res.content[0].text, /NAVIGATOR STEERING: try the other approach/);
  });

  it("walks through a file with a second select", async () => {
    const b = await boot(rpc(["Walk me through a file…", "claimed.ts"]));
    const res = await run(b, ["claimed.ts"]);
    assert.match(res.content[0].text, /walk me through/);
    assert.match(res.content[0].text, /claimed\.ts/);
    // Two selects: the options, then the files.
    assert.equal(b.selects.length, 2);
    assert.deepEqual(b.selects[1]?.options, ["claimed.ts"]);
  });

  it("treats an abandoned option select as a dismissal", async () => {
    const b = await boot(rpc([undefined]));
    const res = await run(b);
    assert.match(res.content[0].text, /no answer/);
  });

  it("treats an abandoned steering prompt as a dismissal, not as steering", async () => {
    const b = await boot(rpc(["Change direction…"], undefined));
    const res = await run(b);
    assert.match(res.content[0].text, /no answer/);
  });

  it("treats an empty steering prompt as a dismissal", async () => {
    const b = await boot(rpc(["Change direction…"], "   "));
    const res = await run(b);
    assert.match(res.content[0].text, /no answer/);
  });

  it("treats an abandoned file select as a dismissal", async () => {
    const b = await boot(rpc(["Walk me through a file…", undefined]));
    const res = await run(b, ["a.ts"]);
    assert.match(res.content[0].text, /no answer/);
  });
});

describe("the plan tool", () => {
  it("approving opens editing, records the plan, and restores the tools", async () => {
    const b = await boot(driver({ planPhase: true }));
    assert.ok(!b.activeTools().includes("edit"), "scoping removes edit");
    assert.ok(!b.activeTools().includes("write"), "scoping removes write");

    const res = await approvePlan(b);
    assert.match(res.content[0].text, /plan approved/);
    assert.equal(res.details.answer, "approve");

    assert.ok(b.activeTools().includes("edit"), "edit restored");
    assert.ok(b.activeTools().includes("write"), "write restored");
    assert.deepEqual(
      b.entries.filter((e) => e.customType === "pear-plan").map((e) => e.data),
      [PLAN_ARGS],
    );

    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.equal(decision, undefined);
  });

  it("revising keeps scoping closed and records nothing", async () => {
    const b = await boot({
      ...driver({ planPhase: true }),
      cardAnswer: { kind: "revise", text: "test first" },
    });
    const res = await b.tools.get("pear_plan")?.execute("p", PLAN_ARGS, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /test first/);
    assert.equal(b.entries.length, 0, "an unapproved plan is not recorded");
    assert.ok(!b.activeTools().includes("edit"), "still scoping");
    const [decision] = await b.emit("tool_call", writeCall("y", "f.ts"), b.ctx);
    assert.match(decision?.reason ?? "", /no plan is approved/);
  });

  it("approving saves the plan to .pear/plans and names the path", async () => {
    const b = await boot(driver({ planPhase: true }));
    const res = await approvePlan(b);
    assert.match(res.content[0].text, /Saved to/);
    assert.match(res.content[0].text, /\.pear\/plans\/latest\.md/);

    const plans = readdirSync(join(b.cwd, ".pear", "plans"));
    const latest = readFileSync(join(b.cwd, ".pear", "plans", "latest.md"), "utf8");
    assert.match(latest, /Do the thing\./);
    assert.match(latest, /1\. First/);
    assert.equal(plans.filter((f) => f.startsWith("approved-")).length, 1, "one snapshot");
  });

  it("a rejected proposal still lands in latest.md, but gets no snapshot", async () => {
    const b = await boot({
      ...driver({ planPhase: true }),
      cardAnswer: { kind: "revise", text: "test first" },
    });
    await b.tools.get("pear_plan")?.execute("p", PLAN_ARGS, undefined, undefined, b.ctx);
    const latest = readFileSync(join(b.cwd, ".pear", "plans", "latest.md"), "utf8");
    assert.match(latest, /Do the thing\./);
    const snapshots = readdirSync(join(b.cwd, ".pear", "plans")).filter((f) =>
      f.startsWith("approved-"),
    );
    assert.equal(snapshots.length, 0);
  });

  it("is out of phase once a plan exists", async () => {
    const b = await boot(driver({ planPhase: true }));
    await approvePlan(b);
    const before = readdirSync(join(b.cwd, ".pear", "plans"));
    const res = await b.tools.get("pear_plan")?.execute("p2", PLAN_ARGS, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /already approved/);
    assert.equal(res.details.answer, "not-run");
    assert.deepEqual(readdirSync(join(b.cwd, ".pear", "plans")), before, "nothing written");
  });

  it("a checkpoint before a plan is out of phase", async () => {
    const b = await boot(driver({ planPhase: true }));
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /no plan is approved/);
    assert.equal(res.details.answer, "not-run");
  });
});

describe("plan persistence across a reload", () => {
  it("picks the plan back up and stays in the building phase", async () => {
    const cwd = tempRepo();
    const first = await boot({ cwd, ...driver({ planPhase: true }) });
    await approvePlan(first);

    // Same session history, fresh extension instance.
    const pi = fakePi(first.entries, []);
    pear(pi.api as never);
    const c = fakeCtx({ cwd, entries: first.entries });
    await pi.emit("session_start", { reason: "reload" }, c.ctx);

    assert.ok(c.notifications.some((n) => /picked up the plan/.test(n.message)));
    const [prompt] = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, c.ctx);
    assert.match(prompt.systemPrompt, /you are the driver/i);
    assert.match(prompt.systemPrompt, /Do the thing\./);

    const [decision] = await pi.emit("tool_call", writeCall("x", "f.ts"), c.ctx);
    assert.equal(decision, undefined, "editing is open again");
  });

  it("ignores a malformed plan entry rather than trusting it", async () => {
    const cwd = tempRepo();
    const entries: Entry[] = [{ type: "custom", customType: "pear-plan", data: { nope: 1 } }];
    const b = await boot({ cwd, ...driver({ planPhase: true }), entries });
    const [prompt] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.match(prompt.systemPrompt, /discover before you build/i, "still scoping");
  });
});

describe("the ask tool", () => {
  it("returns the chosen option", async () => {
    const b = await boot({
      ...driver({ planPhase: true }),
      cardAnswer: { kind: "answer", text: "use the existing queue" },
    });
    const res = await b.tools
      .get("pear_ask")
      ?.execute("a", { question: "Which queue?", options: [{ label: "use the existing queue" }] }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /use the existing queue/);
    assert.equal(res.terminate, false);
  });

  it("offers a free-text escape alongside the options in RPC", async () => {
    const b = await boot({
      ...driver({ planPhase: true }),
      mode: "rpc",
      selectAnswers: ["Something else…"],
      inputAnswer: "neither, do X",
    });
    const res = await b.tools
      .get("pear_ask")
      ?.execute("a", { question: "Which?", options: [{ label: "A" }, { label: "B" }] }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /neither, do X/);
    assert.deepEqual(b.selects[0]?.options, ["A", "B", "Something else…"]);
  });

  it("ends the turn rather than letting the agent guess when dismissed", async () => {
    const b = await boot({ ...driver({ planPhase: true }), cardAnswer: null });
    const res = await b.tools
      .get("pear_ask")
      ?.execute("a", { question: "Which?", options: [{ label: "A" }] }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /rather than guessing/);
    assert.equal(res.terminate, true);
  });
});

describe("scoping tool gating", () => {
  it("restores exactly what it removed, keeping tools added meanwhile", async () => {
    const b = await boot(driver({ planPhase: true }));
    // Another extension registers a tool while pear is scoping.
    b.api.setActiveTools([...b.activeTools(), "other_tool"]);
    await approvePlan(b);

    const active = b.activeTools();
    assert.ok(active.includes("edit"));
    assert.ok(active.includes("write"));
    assert.ok(active.includes("other_tool"), "must not clobber another extension's tool");
  });

  it("restores the tools with a PURELY ADDITIVE setActiveTools call", async () => {
    // The restore happens mid-run, inside pear_plan.execute. pi only honours a
    // mid-run tool change when it is additive — remove anything in the same
    // call and the model may never see edit/write, breaking the approve→build
    // handoff. Nothing else in this suite can catch that.
    const b = await boot(driver({ planPhase: true }));
    const before = b.activeTools();
    await approvePlan(b);

    const restoreCall = b.toolSetCalls.at(-1);
    assert.ok(restoreCall, "the restore must actually call setActiveTools");
    for (const name of before) {
      assert.ok(restoreCall.includes(name), `${name} must not be dropped by the restore`);
    }
    assert.ok(restoreCall.length > before.length, "and it must add edit/write");
  });

  it("closes editing again on /pear", async () => {
    const b = await boot(driver({ planPhase: true }));
    await approvePlan(b);
    await b.commands.get("pear")?.handler("", b.ctx);

    assert.ok(!b.activeTools().includes("edit"));
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.match(decision?.reason ?? "", /no plan is approved/);
  });
});

describe("exclusive mode", () => {
  it("suggests it when foreign tools are present", async () => {
    const b = await boot({ ...driver(), extraTools: ["other_tool"] });
    assert.ok(b.notifications.some((n) => /works best alone/.test(n.message)));
    assert.ok(b.activeTools().includes("other_tool"), "only suggested, not applied");
  });

  it("says nothing when only pi and pear tools are active", async () => {
    const b = await boot(driver());
    assert.equal(b.notifications.filter((n) => /works best alone/.test(n.message)).length, 0);
  });

  it("disables foreign tools when configured", async () => {
    const b = await boot({ ...driver({ exclusive: true }), extraTools: ["other_tool"] });
    assert.ok(!b.activeTools().includes("other_tool"));
    assert.ok(b.activeTools().includes("bash"), "pi's own tools stay");
    assert.ok(b.activeTools().includes("pear_checkpoint"), "pear's own tools stay");
  });

  it("/pear-exclusive applies and persists it", async () => {
    const b = await boot({ ...driver(), extraTools: ["other_tool"] });
    await b.commands.get("pear-exclusive")?.handler("", b.ctx);
    assert.ok(!b.activeTools().includes("other_tool"));
    const onDisk = JSON.parse(readFileSync(join(b.cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.exclusive, true);
  });
});

describe("checkpoint tool — failure and teardown", () => {
  const run = (b: Awaited<ReturnType<typeof boot>>, id = "t") =>
    b.tools
      .get("pear_checkpoint")
      ?.execute(id, { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);

  it("returns actionable guidance instead of throwing when the UI fails", async () => {
    const b = await boot({ ...driver(), customThrows: new Error("terminal exploded") });
    const res = await run(b);
    assert.match(res.content[0].text, /could not be shown/);
    assert.match(res.content[0].text, /terminal exploded/);
    assert.equal(res.details.answer, "error");
  });

  it("does not acknowledge files when the checkpoint fails", async () => {
    const cwd = tempRepo();
    const b = await boot({ cwd, ...driver(), customThrows: new Error("nope") });
    writeFileSync(join(cwd, "pending.txt"), "x\n");

    const failed = await run(b);
    assert.equal(failed.details.answer, "error");

    // Same session, working UI: the unreviewed file must still be reported,
    // i.e. the failed attempt did not move the baseline.
    (b.ctx.ui as any).custom = async () => ({ kind: "continue" });
    await b.emit("input", { text: "ok", source: "interactive" }, b.ctx);
    await b.commands.get("pear-status")?.handler("", b.ctx);
    assert.ok(
      b.notifications.some((n) => /1 file\(s\) changed since last checkpoint/.test(n.message)),
      "a failed checkpoint must not acknowledge anything",
    );
  });

  it("a second checkpoint while one is open is rejected", async () => {
    const b = await boot(driver());
    let release: (v: unknown) => void = () => {};
    (b.ctx.ui as any).custom = () => new Promise((r) => (release = r));

    const first = run(b, "t1");
    const second = await run(b, "t2");

    assert.match(second.content[0].text, /already open/);
    release({ kind: "continue" });
    await first;
  });

  it("session shutdown resolves an open card instead of hanging", async () => {
    const b = await boot(driver());
    (b.ctx.ui as any).custom = () => new Promise(() => {}); // never resolves

    const inFlight = run(b);
    await b.emit("session_shutdown", { reason: "quit" }, b.ctx);

    const res = await inFlight;
    assert.match(res.content[0].text, /no answer/, "shutdown resolves the card as dismissed");
  });

  it("aborting the tool resolves an open card", async () => {
    const b = await boot(driver());
    (b.ctx.ui as any).custom = () => new Promise(() => {});

    const controller = new AbortController();
    const inFlight = b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, controller.signal, undefined, b.ctx);
    controller.abort();

    const res = await inFlight;
    assert.match(res.content[0].text, /no answer/);
  });

  it("every tool is a no-op in off mode", async () => {
    const b = await boot({ config: { mode: "off" } });
    for (const [name, args] of [
      ["pear_ask", { question: "q", options: [] }],
      ["pear_plan", PLAN_ARGS],
      ["pear_checkpoint", { summary: "s", files: [], next: "n" }],
    ] as const) {
      const res = await b.tools.get(name)?.execute("t", args, undefined, undefined, b.ctx);
      assert.match(res.content[0].text, /not in agent-driver/, name);
      assert.notEqual(res.terminate, true, name);
    }
  });
});

describe("/pear-checkpoint", () => {
  it("opens a checkpoint without the model's involvement", async () => {
    const b = await boot({ ...driver({ reviewBudget: 200 }), cardAnswer: { kind: "continue" } });
    await b.emit("tool_call", writeCall("big", "big.ts", 400), b.ctx);
    assert.ok((await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx))[0]?.block);

    await b.commands.get("pear-checkpoint")?.handler("", b.ctx);

    const [decision] = await b.emit("tool_call", writeCall("after", "f.ts"), b.ctx);
    assert.equal(decision, undefined, "the human unwedged the budget themselves");
  });
});

describe("run boundary", () => {
  it("notifies once on agent_settled when work is uncheckpointed", async () => {
    const b = await boot(driver());
    await b.emit("tool_call", writeCall("a", "a.ts", 3), b.ctx);
    await b.emit("tool_result", { toolCallId: "a", toolName: "write", isError: false, content: [] }, b.ctx);

    await b.emit("agent_settled", {}, b.ctx);
    const notes = b.notifications.filter((n) => /not yet checkpointed/.test(n.message));
    assert.equal(notes.length, 1);
  });

  it("says nothing when everything is checkpointed", async () => {
    const b = await boot(driver());
    await b.emit("agent_settled", {}, b.ctx);
    assert.equal(b.notifications.filter((n) => /not yet checkpointed/.test(n.message)).length, 0);
  });

  it("warns when a walkthrough was never followed up", async () => {
    const b = await boot({ ...driver(), cardAnswer: { kind: "explain", file: "a.ts" } });
    await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: ["a.ts"], next: "n" }, undefined, undefined, b.ctx);

    await b.emit("agent_settled", {}, b.ctx);
    assert.ok(
      b.notifications.some((n) => n.type === "warning" && /without a follow-up/.test(n.message)),
    );
  });
});

describe("/pear-config", () => {
  it("persists a valid budget and applies it immediately", async () => {
    const b = await boot(driver());
    await b.commands.get("pear-config")?.handler("80", b.ctx);

    const onDisk = JSON.parse(readFileSync(join(b.cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.reviewBudget, 80);

    await b.emit("tool_call", writeCall("a", "a.ts", 200), b.ctx);
    const [decision] = await b.emit("tool_call", writeCall("b", "b.ts", 1), b.ctx);
    assert.equal(decision?.block, true, "new budget takes effect immediately");
  });

  it("rejects an invalid budget", async () => {
    const b = await boot(driver());
    await b.commands.get("pear-config")?.handler("0", b.ctx);
    assert.ok(b.notifications.some((n) => n.type === "error"));
  });
});

describe("/pear-plan and /pear-status", () => {
  it("/pear-plan shows nothing before approval and the plan after", async () => {
    const b = await boot(driver({ planPhase: true }));
    await b.commands.get("pear-plan")?.handler("", b.ctx);
    assert.ok(b.notifications.some((n) => /no plan approved yet/.test(n.message)));

    await approvePlan(b);
    await b.commands.get("pear-plan")?.handler("", b.ctx);
    assert.ok(b.notifications.some((n) => /1\. First/.test(n.message)));
  });

  it("/pear-status reports the load and its tier", async () => {
    const b = await boot(driver({ reviewBudget: 200 }));
    await b.emit("tool_call", writeCall("a", "a.ts", 100), b.ctx);
    await b.commands.get("pear-status")?.handler("", b.ctx);
    assert.ok(b.notifications.some((n) => /140\/200 points \(soft\)/.test(n.message)));
  });
});

describe("source hygiene", () => {
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("contains no ctx.abort() call sites", () => {
    // Aborting the run is what stopped the model from ever seeing a block
    // reason in the first implementation. Comments may discuss it; code may not
    // call it.
    for (const file of ["adapters/pi/extensions/pear.ts", "adapters/pi/runtime.ts"]) {
      const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
      const calls = src.match(/\bctx\s*\.\s*abort\s*\(/g) ?? [];
      assert.deepEqual(calls, [], `${file} must never abort the agent run`);
    }
  });

  it("decides tool_call synchronously", async () => {
    // A hook that awaits can stall the whole agent loop behind a human. The
    // waiting belongs in the tools, which are allowed to block.
    const b = await boot(driver());
    const hooks = b.handlers.get("tool_call") ?? [];
    assert.ok(hooks.length > 0);
    for (const hook of hooks) {
      assert.notEqual(hook.constructor.name, "AsyncFunction", "tool_call must not be async");
      const returned = hook(writeCall("sync", "f.ts"), b.ctx);
      assert.notEqual(typeof (returned as any)?.then, "function", "must not return a promise");
    }
  });
});

/* ------------------------------------------------- human-driver lifecycle */

const navigator = (extra: PearConfig = {}): BootOptions => ({
  config: { mode: "human-driver", ...extra },
});

/** Make `lines` lines of change the human "wrote". */
function humanEdits(b: Awaited<ReturnType<typeof boot>>, path: string, lines: number): void {
  writeFileSync(join(b.cwd, path), Array.from({ length: lines }, (_, i) => `l${i}`).join("\n"));
}

/**
 * Let the watcher adopt the current tree as its baseline. Everything the human
 * does after this is theirs to explain; everything before it is not.
 */
function adopt(b: Awaited<ReturnType<typeof boot>>): void {
  b.timers.poll(1);
}

describe("human-driver: registration and gating", () => {
  it("registers the new commands", async () => {
    const b = await boot(navigator());
    assert.ok(b.commands.has("pear-swap"));
    assert.ok(b.commands.has("pear-explain"));
  });

  it("takes the write tools away from the agent", async () => {
    const b = await boot(navigator());
    assert.ok(!b.activeTools().includes("edit"));
    assert.ok(!b.activeTools().includes("write"));
    assert.ok(b.activeTools().includes("read"), "reading is the whole job");
  });

  it("blocks a mutating call without aborting the run", async () => {
    const b = await boot(navigator());
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts", 3), b.ctx);
    assert.equal(decision?.block, true);
    assert.match(decision.reason, /the human is driving/);
    assert.equal(b.abortCalls(), 0);
  });

  it("injects the navigator persona, carrying the plan", async () => {
    const b = await boot(navigator({ planPhase: true }));
    await approvePlan(b);
    const [result] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.match(result.systemPrompt, /you are the navigator/i);
    assert.match(result.systemPrompt, /cannot edit anything/);
    assert.match(result.systemPrompt, /Do the thing\./);
  });

  it("falls back to off outside a git repository, leaving the config alone", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pear-nogit-"));
    const b = await boot({ cwd, ...navigator() });
    assert.ok(b.notifications.some((n) => /needs a git repository/.test(n.message)));

    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.equal(decision, undefined, "pear is inert");
    const onDisk = JSON.parse(readFileSync(join(cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.mode, "human-driver", "config untouched");
  });
});

describe("human-driver: the watcher", () => {
  it("starts polling when the human drives", async () => {
    const b = await boot(navigator());
    assert.equal(b.timers.started(), 1);
    assert.equal(b.timers.liveCount(), 1);
  });

  it("does not poll when the agent drives", async () => {
    const b = await boot(driver());
    assert.equal(b.timers.started(), 0);
  });

  it("stops polling on session shutdown", async () => {
    const b = await boot(navigator());
    await b.emit("session_shutdown", { reason: "quit" }, b.ctx);
    assert.equal(b.timers.liveCount(), 0, "a timer must not outlive its session");
  });

  it("does not stack a second timer on a session switch", async () => {
    const b = await boot(navigator());
    await b.emit("session_shutdown", { reason: "new" }, b.ctx);
    await b.emit("session_start", { reason: "new" }, b.ctx);
    assert.equal(b.timers.liveCount(), 1, "exactly one watcher at a time");
  });

  it("nudges once enough has changed, without starting a turn", async () => {
    const b = await boot(navigator({ reviewBudget: 200 }));
    adopt(b);
    humanEdits(b, "work.ts", 80); // 40 + 80 = 120 -> soft
    b.timers.poll(12); // notice, then settle past the debounce

    const nudge = b.widgets.find(([key, content]) => key === "pear-nudge" && content !== undefined);
    assert.ok(nudge, "expected a nudge widget");
    assert.match(nudge[1]?.join(" ") ?? "", /1 file/);
    assert.deepEqual(b.sentUserMessages, [], "a nudge never starts a turn");
  });

  it("auto-triggers a turn once the work gets large", async () => {
    const b = await boot(navigator({ reviewBudget: 200 }));
    adopt(b);
    humanEdits(b, "big.ts", 400);
    b.timers.poll(12);

    assert.equal(b.sentUserMessages.length, 1);
    assert.match(b.sentUserMessages[0] ?? "", /^\(pear\)/);
    assert.match(b.sentUserMessages[0] ?? "", /walk you through/);
  });

  it("refuses to start a turn while the agent is busy", async () => {
    const b = await boot({ ...navigator({ reviewBudget: 200 }), idle: false });
    adopt(b);
    humanEdits(b, "big.ts", 400);
    b.timers.poll(12);
    assert.deepEqual(b.sentUserMessages, [], "sendUserMessage would throw mid-stream");
  });

  it("refuses to start a turn under a half-typed message", async () => {
    const b = await boot({ ...navigator({ reviewBudget: 200 }), editorText: "I was saying" });
    adopt(b);
    humanEdits(b, "big.ts", 400);
    b.timers.poll(12);
    assert.deepEqual(b.sentUserMessages, [], "burying their message would be rude");
  });

  it("asks once the editor clears, rather than going quiet for good", async () => {
    // A declined trigger leaves the watcher waiting to be answered by a
    // question that was never asked. Without a re-arm that is a silent wedge:
    // no nudge, no trigger, for the rest of the session.
    const b = await boot({ ...navigator({ reviewBudget: 200 }), editorText: "I was saying" });
    adopt(b);
    humanEdits(b, "big.ts", 400);
    b.timers.poll(12);
    assert.deepEqual(b.sentUserMessages, [], "not while they are typing");

    b.setEditorText("");
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1, "asked as soon as it could");
  });

  it("asks once the agent goes idle, rather than going quiet for good", async () => {
    const b = await boot({ ...navigator({ reviewBudget: 200 }), idle: false });
    adopt(b);
    humanEdits(b, "big.ts", 400);
    b.timers.poll(12);
    assert.deepEqual(b.sentUserMessages, []);

    b.setIdle(true);
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1);
  });

  it("does not raise work that predates the session", async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "already.ts"), Array.from({ length: 400 }, (_, i) => `l${i}`).join("\n"));
    const b = await boot({ cwd, ...navigator({ reviewBudget: 200 }) });
    b.timers.poll(12);
    assert.deepEqual(b.sentUserMessages, [], "not the human's to explain");
  });
});

describe("human-driver: the quiz", () => {
  /**
   * Drive a real auto-trigger and return the harness, settled on the question.
   *
   * A quiz spans two runs — pear injects a message, the agent asks the question,
   * *that* run settles, and only then does the human reply. Skipping the first
   * settle here would test an ordering that never happens.
   */
  async function quizzed(reviewBudget = 200) {
    const b = await boot(navigator({ reviewBudget }));
    adopt(b);
    humanEdits(b, "work.ts", 400);
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1, "expected the quiz to fire");
    await b.emit("agent_settled", {}, b.ctx);
    return b;
  }

  it("stays open when the question turn settles", async () => {
    // The human has not answered yet. Ending the quiz here would rebaseline
    // over work nobody discussed and the diff would never be attached.
    const b = await quizzed();
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1, "no second quiz for the same work");

    const [result] = await b.emit("input", { text: "so what I did", source: "interactive" }, b.ctx);
    assert.equal(result.action, "transform", "the quiz is still open, so the diff attaches");
    assert.match(result.text, /<pear-diff/);
  });

  it("attaches the diff to the human's explanation", async () => {
    const b = await quizzed();
    const [result] = await b.emit(
      "input",
      { text: "I added a retry wrapper", source: "interactive" },
      b.ctx,
    );
    assert.equal(result.action, "transform");
    assert.match(result.text, /^I added a retry wrapper/);
    assert.match(result.text, /<pear-diff/);
    assert.match(result.text, /work\.ts/);
  });

  it("does not attach a diff when nobody asked", async () => {
    const b = await boot(navigator());
    const [result] = await b.emit("input", { text: "hello", source: "interactive" }, b.ctx);
    assert.equal(result, undefined);
  });

  it("never attaches a diff to its own injected message", async () => {
    const b = await quizzed();
    const [result] = await b.emit("input", { text: "(pear) ...", source: "extension" }, b.ctx);
    assert.equal(result, undefined, "pear must not staple a diff to itself");
  });

  it("acknowledges once the review turn settles", async () => {
    const b = await quizzed();
    await b.emit("input", { text: "here is what I did", source: "interactive" }, b.ctx);
    await b.emit("agent_settled", {}, b.ctx); // the *answer* turn

    // Same tree, so nothing new to raise.
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1, "work already discussed is not re-raised");
  });

  it("acknowledges even when the human declined to explain", async () => {
    // The agent is the navigator here and was shown the diff either way.
    const b = await quizzed();
    await b.emit("input", { text: "not now", source: "interactive" }, b.ctx);
    await b.emit("agent_settled", {}, b.ctx);
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1);
  });

  it("starts on demand even with a half-typed message", async () => {
    // Typing /pear-explain *is* the answer to "is now a good time?". The guard
    // exists to stop pear interrupting; it must not stop the human asking.
    const b = await boot({ ...navigator(), editorText: "/pear-explain" });
    adopt(b);
    humanEdits(b, "work.ts", 20);
    await b.commands.get("pear-explain")?.handler("", b.ctx);
    assert.equal(b.sentUserMessages.length, 1);
  });

  it("declines on demand when the agent is mid-turn, and says why", async () => {
    const b = await boot({ ...navigator(), idle: false });
    adopt(b);
    humanEdits(b, "work.ts", 20);
    await b.commands.get("pear-explain")?.handler("", b.ctx);
    assert.deepEqual(b.sentUserMessages, []);
    assert.ok(b.notifications.some((n) => /mid-turn/.test(n.message)));
  });

  it("raises the next batch of work after a review", async () => {
    const b = await quizzed();
    await b.emit("input", { text: "explained", source: "interactive" }, b.ctx);
    await b.emit("agent_settled", {}, b.ctx);

    humanEdits(b, "more.ts", 400);
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 2);
  });
});

describe("/pear-explain", () => {
  it("starts a review on demand", async () => {
    const b = await boot(navigator());
    humanEdits(b, "work.ts", 5);
    await b.commands.get("pear-explain")?.handler("", b.ctx);
    assert.equal(b.sentUserMessages.length, 1, "no threshold to wait for");
  });

  it("says so when there is nothing to talk about", async () => {
    const b = await boot(navigator());
    await b.commands.get("pear-explain")?.handler("", b.ctx);
    assert.deepEqual(b.sentUserMessages, []);
    assert.ok(b.notifications.some((n) => /nothing has changed/.test(n.message)));
  });

  it("works even after the watcher has parked", async () => {
    // The escape hatch must not depend on the thing that broke.
    const b = await boot(navigator());
    humanEdits(b, "work.ts", 5);
    await b.emit("session_shutdown", { reason: "quit" }, b.ctx);
    await b.commands.get("pear-explain")?.handler("", b.ctx);
    assert.equal(b.sentUserMessages.length, 1);
  });

  it("points at /pear-checkpoint when the agent is driving", async () => {
    const b = await boot(driver());
    await b.commands.get("pear-explain")?.handler("", b.ctx);
    assert.ok(b.notifications.some((n) => /pear-checkpoint/.test(n.message)));
  });
});

describe("/pear-swap", () => {
  it("hands the keyboard to the human and starts watching", async () => {
    const b = await boot(driver());
    assert.equal(b.timers.started(), 0);

    await b.commands.get("pear-swap")?.handler("", b.ctx);
    assert.equal(b.timers.liveCount(), 1, "now watching");
    assert.ok(!b.activeTools().includes("edit"), "agent may no longer edit");
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.match(decision?.reason ?? "", /the human is driving/);
  });

  it("hands it back and stops watching", async () => {
    const b = await boot(navigator());
    await b.commands.get("pear-swap")?.handler("", b.ctx);

    assert.equal(b.timers.liveCount(), 0, "no longer watching");
    assert.ok(b.activeTools().includes("edit"), "agent may edit again");
    const [decision] = await b.emit("tool_call", writeCall("x", "f.ts"), b.ctx);
    assert.equal(decision, undefined);
  });

  it("restores the write tools additively", async () => {
    const b = await boot(navigator());
    b.api.setActiveTools([...b.activeTools(), "other_tool"]);
    await b.commands.get("pear-swap")?.handler("", b.ctx);

    const restore = b.toolSetCalls.at(-1);
    assert.ok(restore?.includes("edit"));
    assert.ok(restore?.includes("other_tool"), "must not clobber another extension's tool");
  });

  it("keeps the plan across the handover", async () => {
    const b = await boot(driver({ planPhase: true }));
    await approvePlan(b);
    await b.commands.get("pear-swap")?.handler("", b.ctx);

    await b.commands.get("pear-plan")?.handler("", b.ctx);
    assert.ok(b.notifications.some((n) => /1\. First/.test(n.message)));
  });

  it("does not persist the handover to disk", async () => {
    const b = await boot(driver());
    await b.commands.get("pear-swap")?.handler("", b.ctx);
    const onDisk = JSON.parse(readFileSync(join(b.cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.mode, "agent-driver", "swap is session-level; /pear-mode persists");
  });

  it("refuses to hand over outside a git repository", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pear-nogit-"));
    execFileSync("git", ["init", "-q"], { cwd });
    const b = await boot({ cwd, ...driver() });
    // Break the repo out from under it.
    execFileSync("rm", ["-rf", join(cwd, ".git")]);

    await b.commands.get("pear-swap")?.handler("", b.ctx);
    assert.ok(b.notifications.some((n) => /git repository/.test(n.message)));
    assert.equal(b.timers.liveCount(), 0, "never started watching");
  });
});

describe("human-driver: re-triggering", () => {
  it("does not re-raise explained work when the human types one more line", async () => {
    const b = await boot(navigator({ reviewBudget: 200 }));
    adopt(b);
    humanEdits(b, "work.ts", 400);
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1);
    await b.emit("agent_settled", {}, b.ctx);
    await b.emit("input", { text: "explained", source: "interactive" }, b.ctx);
    await b.emit("agent_settled", {}, b.ctx);

    humanEdits(b, "work.ts", 402); // two more lines, nothing like a new batch
    b.timers.poll(12);
    assert.equal(b.sentUserMessages.length, 1, "already discussed");
  });
});
