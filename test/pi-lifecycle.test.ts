import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import pear from "../adapters/pi/extensions/pear.ts";
import { saveConfig } from "../core/config.ts";

/* ------------------------------------------------------------------ fakes */

type Handler = (event: any, ctx: any) => any;
type ToolDef = {
  name: string;
  description: string;
  executionMode?: string;
  execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: any) => Promise<any>;
  renderCall?: (args: any, theme: any) => unknown;
  renderResult?: (result: any, options: any, theme: any) => unknown;
};

type Notification = { message: string; type?: string };

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();

  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (tool: ToolDef) => tools.set(tool.name, tool),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    registerEntryRenderer: () => {},
    registerMessageRenderer: () => {},
    appendEntry: () => {},
    sendUserMessage: () => {},
  };

  const emit = async (event: string, payload: unknown, ctx: unknown) => {
    const results = [];
    for (const h of handlers.get(event) ?? []) results.push(await h(payload, ctx));
    return results;
  };

  return { api, emit, tools, commands, handlers };
}

const theme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};

type CtxOptions = {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  /** Answer for ui.custom (TUI card). */
  cardAnswer?: unknown;
  /** Answers for ui.select / ui.input (RPC path). */
  selectAnswer?: string | undefined;
  inputAnswer?: string | undefined;
  customThrows?: Error;
};

function fakeCtx(opts: CtxOptions) {
  const notifications: Notification[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  let abortCalls = 0;

  const mode = opts.mode ?? "tui";
  const ctx = {
    cwd: opts.cwd,
    mode,
    hasUI: opts.hasUI ?? (mode !== "print" && mode !== "json"),
    signal: undefined as AbortSignal | undefined,
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
      select: async (_title: string, _options: string[]) => opts.selectAnswer,
      input: async (_title: string) => opts.inputAnswer,
    },
  };

  return {
    ctx,
    notifications,
    statuses,
    abortCalls: () => abortCalls,
  };
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pear-life-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

/** Boot the extension and return everything needed to drive it. */
async function boot(opts: Omit<CtxOptions, "cwd"> & { cwd?: string; mode_?: "off" | "agent-driver" }) {
  const cwd = opts.cwd ?? tempRepo();
  if (opts.mode_ !== undefined) saveConfig(cwd, { mode: opts.mode_ });

  const pi = fakePi();
  pear(pi.api as never);
  const c = fakeCtx({ ...opts, cwd });
  await pi.emit("session_start", {}, c.ctx);
  return { ...pi, ...c, cwd };
}

/* ------------------------------------------------------------------ tests */

describe("registration", () => {
  it("registers the checkpoint tool and commands", async () => {
    const b = await boot({ mode_: "agent-driver" });
    assert.ok(b.tools.has("pear_checkpoint"));
    assert.equal(b.tools.get("pear_checkpoint")?.executionMode, "sequential");
    for (const cmd of ["pear-status", "pear-checkpoint", "pear-mode", "pear-config"]) {
      assert.ok(b.commands.has(cmd), `missing /${cmd}`);
    }
  });

  it("registers the tool even in off mode (pi cannot unregister)", async () => {
    const b = await boot({ mode_: "off" });
    assert.ok(b.tools.has("pear_checkpoint"));
  });
});

describe("persona injection", () => {
  it("adds the driver persona only in agent-driver mode", async () => {
    const on = await boot({ mode_: "agent-driver" });
    const [result] = await on.emit("before_agent_start", { systemPrompt: "BASE" }, on.ctx);
    assert.match(result.systemPrompt, /^BASE/);
    assert.match(result.systemPrompt, /you are the driver/i);
    assert.match(result.systemPrompt, /pear_checkpoint/);
  });

  it("leaves the prompt alone in off mode", async () => {
    const off = await boot({ mode_: "off" });
    const [result] = await off.emit("before_agent_start", { systemPrompt: "BASE" }, off.ctx);
    assert.equal(result, undefined);
  });
});

describe("headless policy", () => {
  it("fails closed to off when there is no dialog-capable UI", async () => {
    const b = await boot({ mode_: "agent-driver", mode: "print", hasUI: false });
    const [result] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.equal(result, undefined, "no persona: pear is off for this session");
    assert.ok(
      b.notifications.some((n) => /needs an interactive session/.test(n.message)),
      "should explain why",
    );
  });

  it("does not rewrite the config when failing closed", async () => {
    const cwd = tempRepo();
    saveConfig(cwd, { mode: "agent-driver" });
    await boot({ cwd, mode: "print", hasUI: false });
    const onDisk = JSON.parse(readFileSync(join(cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.mode, "agent-driver", "user's config must be preserved");
  });

  it("/pear-mode agent-driver saves but does not claim to be running", async () => {
    const b = await boot({ mode_: "off", mode: "print", hasUI: false });
    await b.commands.get("pear-mode")?.handler("agent-driver", b.ctx);

    // Saved, so a later interactive session picks it up...
    const onDisk = JSON.parse(readFileSync(join(b.cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.mode, "agent-driver");

    // ...but this session says plainly that it is not active.
    assert.ok(
      b.notifications.some(
        (n) => n.type === "warning" && /needs an interactive session/.test(n.message),
      ),
    );

    // And it really is inert here: no persona, no gating.
    const [prompt] = await b.emit("before_agent_start", { systemPrompt: "BASE" }, b.ctx);
    assert.equal(prompt, undefined, "must not run agent-driver without a human");
    const [decision] = await b.emit(
      "tool_call",
      { toolCallId: "x", toolName: "edit", input: {} },
      b.ctx,
    );
    assert.equal(decision, undefined);
  });
});

describe("legacy config migration", () => {
  it("warns about human-driver and leaves the file byte-identical", async () => {
    const cwd = tempRepo();
    const raw = JSON.stringify({ mode: "human-driver", reviewModel: "a/b" }, null, 2) + "\n";
    execFileSync("mkdir", ["-p", join(cwd, ".pear")]);
    writeFileSync(join(cwd, ".pear", "config.json"), raw);

    const b = await boot({ cwd });
    assert.ok(b.notifications.some((n) => /human-driver/.test(n.message) && /isn't available/.test(n.message)));
    assert.equal(readFileSync(join(cwd, ".pear", "config.json"), "utf8"), raw, "file untouched");
  });
});

describe("the gate hook", () => {
  it("blocks an overdue call without aborting the run", async () => {
    const b = await boot({ mode_: "agent-driver" });
    // default budget is 5
    for (let i = 0; i < 5; i++) {
      await b.emit("tool_call", { toolCallId: `c${i}`, toolName: "edit", input: { path: "f" } }, b.ctx);
    }
    const [decision] = await b.emit(
      "tool_call",
      { toolCallId: "c5", toolName: "edit", input: { path: "f" } },
      b.ctx,
    );

    assert.equal(decision.block, true);
    assert.match(decision.reason, /checkpoint overdue/);
    assert.equal(b.abortCalls(), 0, "ctx.abort() must never be called");
  });

  it("passes non-mutating tools straight through", async () => {
    const b = await boot({ mode_: "agent-driver" });
    const [decision] = await b.emit("tool_call", { toolCallId: "r", toolName: "read", input: {} }, b.ctx);
    assert.equal(decision, undefined);
  });
});

describe("stop latch and input provenance", () => {
  async function stopIt(b: Awaited<ReturnType<typeof boot>>) {
    const tool = b.tools.get("pear_checkpoint");
    await tool?.execute("t1", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
  }

  it("extension-injected messages do NOT clear a stop", async () => {
    const b = await boot({ mode_: "agent-driver", cardAnswer: { kind: "stop" } });
    await stopIt(b);

    await b.emit("input", { text: "go on", source: "extension" }, b.ctx);
    const [decision] = await b.emit("tool_call", { toolCallId: "x", toolName: "edit", input: {} }, b.ctx);
    assert.equal(decision?.block, true, "an extension must not be able to override the human");
  });

  it("real user input clears a stop", async () => {
    const b = await boot({ mode_: "agent-driver", cardAnswer: { kind: "stop" } });
    await stopIt(b);

    await b.emit("input", { text: "carry on", source: "interactive" }, b.ctx);
    const [decision] = await b.emit("tool_call", { toolCallId: "x", toolName: "edit", input: {} }, b.ctx);
    assert.equal(decision, undefined);
  });
});

describe("checkpoint tool — TUI", () => {
  it("continue returns the continue result and does not terminate", async () => {
    const b = await boot({ mode_: "agent-driver", cardAnswer: { kind: "continue" } });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "did a thing", files: ["a.ts"], next: "next thing" }, undefined, undefined, b.ctx);

    assert.match(res.content[0].text, /NAVIGATOR: continue/);
    assert.notEqual(res.terminate, true);
    assert.equal(res.details.answer, "continue");
  });

  it("steering passes the human's words through verbatim", async () => {
    const b = await boot({
      mode_: "agent-driver",
      cardAnswer: { kind: "steer", text: "use a Map, not an object" },
    });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);

    assert.match(res.content[0].text, /NAVIGATOR STEERING: use a Map, not an object/);
    assert.notEqual(res.terminate, true);
  });

  it("stop terminates the agent loop", async () => {
    const b = await boot({ mode_: "agent-driver", cardAnswer: { kind: "stop" } });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);

    assert.match(res.content[0].text, /NAVIGATOR: stop/);
    assert.equal(res.terminate, true);
  });

  it("dismissing the card pauses changes without acknowledging them", async () => {
    const b = await boot({ mode_: "agent-driver", cardAnswer: null });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);

    assert.match(res.content[0].text, /no answer/);
    const [decision] = await b.emit("tool_call", { toolCallId: "x", toolName: "edit", input: {} }, b.ctx);
    assert.equal(decision?.block, true);
  });

  it("reports the git-derived file list alongside the agent's claim", async () => {
    const cwd = tempRepo();
    const b = await boot({ cwd, mode_: "agent-driver", cardAnswer: { kind: "continue" } });
    writeFileSync(join(cwd, "changed.txt"), "new content\n");

    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: ["lied-about.txt"], next: "n" }, undefined, undefined, b.ctx);

    assert.equal(res.details.verified, true);
    assert.deepEqual(res.details.gitFiles, ["changed.txt"]);
    assert.deepEqual(res.details.claimedFiles, ["lied-about.txt"]);
  });
});

describe("checkpoint tool — RPC", () => {
  it("uses dialogs and can continue", async () => {
    const b = await boot({
      mode_: "agent-driver",
      mode: "rpc",
      selectAnswer: "continue — looks good, keep going",
    });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /NAVIGATOR: continue/);
  });

  it("collects steering text via the input dialog", async () => {
    const b = await boot({
      mode_: "agent-driver",
      mode: "rpc",
      selectAnswer: "make changes — I'll type what to do",
      inputAnswer: "try the other approach",
    });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /NAVIGATOR STEERING: try the other approach/);
  });

  it("treats an abandoned steering prompt as a pause, not as steering", async () => {
    const b = await boot({
      mode_: "agent-driver",
      mode: "rpc",
      selectAnswer: "make changes — I'll type what to do",
      inputAnswer: undefined,
    });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /no answer/);
  });
});

describe("checkpoint tool — failure and teardown", () => {
  it("returns actionable guidance instead of throwing when the UI fails", async () => {
    const b = await boot({
      mode_: "agent-driver",
      customThrows: new Error("terminal exploded"),
    });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);

    assert.match(res.content[0].text, /could not be shown/);
    assert.match(res.content[0].text, /terminal exploded/);
    assert.equal(res.details.answer, "error");
  });

  it("does not acknowledge files when the checkpoint fails", async () => {
    const cwd = tempRepo();
    const b = await boot({ cwd, mode_: "agent-driver", customThrows: new Error("nope") });
    const tool = b.tools.get("pear_checkpoint");
    writeFileSync(join(cwd, "pending.txt"), "x\n");

    const failed = await tool?.execute(
      "t",
      { summary: "s", files: [], next: "n" },
      undefined,
      undefined,
      b.ctx,
    );
    assert.equal(failed.details.answer, "error");

    // Same session, working UI: the unreviewed file must still be reported,
    // i.e. the failed attempt did not move the baseline.
    (b.ctx.ui as any).custom = async () => ({ kind: "continue" });
    const res2 = await tool?.execute(
      "t2",
      { summary: "s", files: [], next: "n" },
      undefined,
      undefined,
      b.ctx,
    );
    assert.ok(
      res2.details.gitFiles.includes("pending.txt"),
      "a failed checkpoint must not acknowledge anything",
    );
  });

  it("a second checkpoint while one is open is rejected", async () => {
    const b = await boot({ mode_: "agent-driver" });
    const tool = b.tools.get("pear_checkpoint");

    // Card that never resolves on its own.
    let release: (v: unknown) => void = () => {};
    (b.ctx.ui as any).custom = () => new Promise((r) => (release = r));

    const first = tool?.execute("t1", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
    const second = await tool?.execute("t2", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);

    assert.match(second.content[0].text, /already open/);
    release({ kind: "continue" });
    await first;
  });

  it("session shutdown resolves an open card instead of hanging", async () => {
    const b = await boot({ mode_: "agent-driver" });
    const tool = b.tools.get("pear_checkpoint");
    (b.ctx.ui as any).custom = () => new Promise(() => {}); // never resolves

    const inFlight = tool?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
    await b.emit("session_shutdown", { reason: "quit" }, b.ctx);

    const res = await inFlight;
    assert.match(res.content[0].text, /no answer/, "shutdown resolves the card as dismissed");
  });

  it("aborting the tool resolves an open card", async () => {
    const b = await boot({ mode_: "agent-driver" });
    const tool = b.tools.get("pear_checkpoint");
    (b.ctx.ui as any).custom = () => new Promise(() => {});

    const controller = new AbortController();
    const inFlight = tool?.execute(
      "t",
      { summary: "s", files: [], next: "n" },
      controller.signal,
      undefined,
      b.ctx,
    );
    controller.abort();

    const res = await inFlight;
    assert.match(res.content[0].text, /no answer/);
  });

  it("is a no-op in off mode", async () => {
    const b = await boot({ mode_: "off" });
    const res = await b.tools
      .get("pear_checkpoint")
      ?.execute("t", { summary: "s", files: [], next: "n" }, undefined, undefined, b.ctx);
    assert.match(res.content[0].text, /not in agent-driver/);
  });
});

describe("/pear-checkpoint", () => {
  it("opens a checkpoint without the model's involvement", async () => {
    const b = await boot({ mode_: "agent-driver", cardAnswer: { kind: "continue" } });
    // Use up the budget so the model itself is blocked.
    for (let i = 0; i < 6; i++) {
      await b.emit("tool_call", { toolCallId: `c${i}`, toolName: "edit", input: {} }, b.ctx);
    }

    await b.commands.get("pear-checkpoint")?.handler("", b.ctx);

    const [decision] = await b.emit("tool_call", { toolCallId: "after", toolName: "edit", input: {} }, b.ctx);
    assert.equal(decision, undefined, "the human unwedged the budget themselves");
  });
});

describe("run boundary", () => {
  it("notifies once on agent_settled when work is uncheckpointed", async () => {
    const b = await boot({ mode_: "agent-driver" });
    await b.emit("tool_call", { toolCallId: "a", toolName: "edit", input: {} }, b.ctx);
    await b.emit("tool_result", { toolCallId: "a", toolName: "edit", isError: false }, b.ctx);

    await b.emit("agent_settled", {}, b.ctx);
    const notes = b.notifications.filter((n) => /not yet checkpointed/.test(n.message));
    assert.equal(notes.length, 1);
  });

  it("says nothing when everything is checkpointed", async () => {
    const b = await boot({ mode_: "agent-driver" });
    await b.emit("agent_settled", {}, b.ctx);
    assert.equal(b.notifications.filter((n) => /not yet checkpointed/.test(n.message)).length, 0);
  });
});

describe("/pear-config", () => {
  it("persists a valid budget", async () => {
    const b = await boot({ mode_: "agent-driver" });
    await b.commands.get("pear-config")?.handler("2", b.ctx);

    const onDisk = JSON.parse(readFileSync(join(b.cwd, ".pear", "config.json"), "utf8"));
    assert.equal(onDisk.maxChangesPerCheckpoint, 2);

    await b.emit("tool_call", { toolCallId: "a", toolName: "edit", input: {} }, b.ctx);
    await b.emit("tool_call", { toolCallId: "b", toolName: "edit", input: {} }, b.ctx);
    const [decision] = await b.emit("tool_call", { toolCallId: "c", toolName: "edit", input: {} }, b.ctx);
    assert.equal(decision?.block, true, "new budget takes effect immediately");
  });

  it("rejects an invalid budget", async () => {
    const b = await boot({ mode_: "agent-driver" });
    await b.commands.get("pear-config")?.handler("0", b.ctx);
    assert.ok(b.notifications.some((n) => n.type === "error"));
  });
});

describe("source hygiene", () => {
  it("contains no ctx.abort() call sites", () => {
    // Aborting the run is what stopped the model from ever seeing a block
    // reason in the previous implementation. Comments may discuss it; code
    // may not call it.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    for (const file of ["adapters/pi/extensions/pear.ts", "adapters/pi/runtime.ts"]) {
      const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
      const calls = src.match(/\bctx\s*\.\s*abort\s*\(/g) ?? [];
      assert.deepEqual(calls, [], `${file} must never abort the agent run`);
    }
  });
});
