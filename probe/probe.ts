/**
 * Standalone pi API probe — NOT part of the pear extension.
 *
 * Purpose: empirically confirm the event ordering and identity assumptions
 * recorded in `docs/pi-api-notes.md` against the pinned pi version. It is
 * deliberately independent of `adapters/` so it can be run BEFORE the rewrite
 * (to gate deletion) and AFTER wiring (to confirm nothing drifted).
 *
 * Usage:
 *   pi -e ./probe/probe.ts
 *   # then, in the session:
 *   #   1. ask the model to edit a file (observe tool_call/tool_result order)
 *   #   2. ask it to call probe_block_me (observe a blocked call's events)
 *   #   3. press Esc mid-tool to observe abort behaviour
 *   #   4. /probe-dump  → prints the captured log path
 *   #   5. quit         → observe session_shutdown reason
 *
 * Output: JSONL at $PEAR_PROBE_LOG or ./probe/probe-events.jsonl
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";

const LOG_PATH = resolve(process.env.PEAR_PROBE_LOG ?? "./probe/probe-events.jsonl");

let seq = 0;

function record(event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ seq: seq++, t: Date.now(), event, ...data });
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* probe must never break the session */
  }
}

export default function probe(pi: ExtensionAPI) {
  record("probe_loaded", { logPath: LOG_PATH });

  // --- Identity + ordering of the tool lifecycle -------------------------
  // Confirms: tool_execution_start -> tool_call -> tool_result ->
  // tool_execution_end, that toolCallId correlates them, and whether an
  // aborted call ever reaches tool_result.
  pi.on("tool_execution_start", (e) => {
    record("tool_execution_start", { id: e.toolCallId, tool: e.toolName });
  });

  pi.on("tool_call", (e, ctx) => {
    record("tool_call", {
      id: e.toolCallId,
      tool: e.toolName,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      hasSignal: ctx.signal !== undefined,
    });
    // Exercise the documented block path WITHOUT ctx.abort(), so we can see
    // that a blocked call still produces a model-visible result.
    if (e.toolName === "probe_block_me") {
      return { block: true, reason: "probe: blocked on purpose (no ctx.abort)" };
    }
    return undefined;
  });

  pi.on("tool_result", (e) => {
    record("tool_result", { id: e.toolCallId, tool: e.toolName, isError: e.isError });
  });

  pi.on("tool_execution_end", (e) => {
    record("tool_execution_end", { id: e.toolCallId, tool: e.toolName, isError: e.isError });
  });

  // --- Run boundaries -----------------------------------------------------
  // Confirms agent_end is NOT terminal and agent_settled is.
  pi.on("agent_start", () => record("agent_start"));
  pi.on("agent_end", () => record("agent_end"));
  pi.on("agent_settled", () => record("agent_settled"));
  pi.on("turn_end", (e) => record("turn_end", { turnIndex: e.turnIndex }));

  // --- Input provenance ---------------------------------------------------
  // Confirms InputEvent.source distinguishes real user input from
  // extension-injected messages (pi.sendUserMessage).
  pi.on("input", (e) => {
    record("input", {
      source: e.source,
      streamingBehavior: e.streamingBehavior,
      len: e.text.length,
    });
  });

  // --- Lifecycle / disposal ----------------------------------------------
  // Confirms session_shutdown fires for reload as well as quit.
  pi.on("session_start", (_e, ctx) => {
    record("session_start", { mode: ctx.mode, hasUI: ctx.hasUI, cwd: ctx.cwd });
  });
  pi.on("session_shutdown", (e) => record("session_shutdown", { reason: e.reason }));

  // --- A tool that blocks on UI, to time cancellation --------------------
  // Confirms a tool's execute() may await the human indefinitely, and that
  // signal/shutdown can resolve it without leaking the promise.
  pi.registerTool({
    name: "probe_ask",
    label: "Probe Ask",
    description: "Probe only: opens a UI prompt and waits for the human.",
    parameters: Type.Object({ question: Type.String() }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      record("probe_ask_execute_enter", { id: toolCallId, mode: ctx.mode });

      let settled = false;
      const onAbort = () => {
        if (!settled) record("probe_ask_aborted", { id: toolCallId });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const answer =
          ctx.mode === "tui" || ctx.mode === "rpc"
            ? await ctx.ui.select(params.question, ["continue", "stop"])
            : undefined;
        settled = true;
        record("probe_ask_answered", { id: toolCallId, answer: answer ?? "(none)" });
        return {
          content: [{ type: "text" as const, text: `answer: ${answer ?? "(unavailable)"}` }],
          details: undefined,
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        record("probe_ask_execute_exit", { id: toolCallId });
      }
    },
  });

  // A tool whose only purpose is to be blocked by the tool_call handler.
  pi.registerTool({
    name: "probe_block_me",
    label: "Probe Block Me",
    description: "Probe only: always blocked by the probe's tool_call handler.",
    parameters: Type.Object({}),
    async execute() {
      record("probe_block_me_executed_UNEXPECTED");
      return {
        content: [{ type: "text" as const, text: "should not run" }],
        details: undefined,
      };
    },
  });

  // A tool that terminates the batch, to verify runtime-enforced stop.
  pi.registerTool({
    name: "probe_terminate",
    label: "Probe Terminate",
    description: "Probe only: returns terminate:true to end the agent loop.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(toolCallId) {
      record("probe_terminate_executed", { id: toolCallId });
      return {
        content: [{ type: "text" as const, text: "probe: terminating batch" }],
        details: undefined,
        terminate: true,
      };
    },
  });

  pi.registerCommand("probe-dump", {
    description: "Print the probe log path",
    handler: async (_args, ctx) => {
      record("probe_dump_command");
      ctx.ui.notify(`probe log: ${LOG_PATH}`, "info");
    },
  });
}
