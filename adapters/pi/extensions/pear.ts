import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULTS } from "../../../core/config.ts";
import {
  createPearSession,
  resolveFlags,
  resolveNavComplete,
  type PearSession,
} from "../runtime.ts";

type FindingsData = { lines: string };

export default function (pi: ExtensionAPI) {
  pi.registerFlag("nav-model", {
    description: `Navigator model provider/id (default ${DEFAULTS.navModel})`,
    type: "string",
    default: DEFAULTS.navModel,
  });
  pi.registerFlag("no-nav", {
    description: "Disable navigator reviews",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("pause-lines", {
    description: `Checkpoint after N new lines (default ${DEFAULTS.pauseLines})`,
    type: "string",
    default: String(DEFAULTS.pauseLines),
  });
  pi.registerFlag("pause-edits", {
    description: `Checkpoint after N mutations (default ${DEFAULTS.pauseEdits})`,
    type: "string",
    default: String(DEFAULTS.pauseEdits),
  });
  pi.registerFlag("min-lines", {
    description: `Navigator min change size (default ${DEFAULTS.minLines})`,
    type: "string",
    default: String(DEFAULTS.minLines),
  });
  pi.registerFlag("debounce", {
    description: `Navigator quiet period seconds (default ${DEFAULTS.debounceSeconds})`,
    type: "string",
    default: String(DEFAULTS.debounceSeconds),
  });
  pi.registerFlag("interval", {
    description: `Min seconds between reviews (default ${DEFAULTS.intervalSeconds})`,
    type: "string",
    default: String(DEFAULTS.intervalSeconds),
  });

  pi.registerEntryRenderer<FindingsData>("pear-nav", (entry, _opts, theme) => {
    const lines = entry.data?.lines ?? "";
    return new Text(theme.fg("accent", lines), 0, 0);
  });

  let session: PearSession | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const flags = resolveFlags((name) => pi.getFlag(name));
    const complete = await resolveNavComplete(
      ctx.modelRegistry,
      flags.navModel,
      streamSimple as any,
    );

    session = createPearSession({
      cwd: ctx.cwd,
      flags,
      ui: {
        hasUI: ctx.hasUI,
        input: (title, placeholder) => ctx.ui.input(title, placeholder),
        notify: (message, type) => ctx.ui.notify(message, type),
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
      },
      complete,
      onFindings: (text) => pi.appendEntry<FindingsData>("pear-nav", { lines: text }),
      sendUserMessage: (text) => pi.sendUserMessage(text),
    });
    session.start();
  });

  pi.on("session_shutdown", () => {
    session?.stop();
    session = null;
  });

  pi.on("before_agent_start", async (event) => {
    if (!session) return undefined;
    return { systemPrompt: session.personaSystemPrompt(event.systemPrompt) };
  });

  pi.on("agent_start", (_event, _ctx) => {
    session?.onAgentStart();
  });

  pi.on("agent_end", async (_event, _ctx) => {
    await session?.onAgentEnd();
  });

  pi.on("turn_end", () => {
    session?.onTurnEnd();
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (!session) return undefined;
    return session.onToolCall({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
    });
  });

  pi.on("tool_result", (event) => {
    session?.onToolResult(event.toolCallId, event.isError);
  });

  pi.registerCommand("pear-status", {
    description: "Show pear navigator/checkpoint status",
    handler: async (_args, ctx) => {
      const text = session?.statusText() ?? "pear: not started";
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });
}
