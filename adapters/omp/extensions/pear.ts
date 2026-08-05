import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
// Host-package imports MUST target package roots: omp's extension loader remaps
// `@oh-my-pi/pi-*` roots onto the copies bundled in the running binary, but a
// subpath like `@oh-my-pi/pi-ai/stream` falls through to the plugin's own
// node_modules and fails on transitive `@oh-my-pi/pi-catalog/*` imports.
import { completeSimple } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import { homedir } from "node:os";
import { DEFAULTS, resolveNavModelPreference, saveUserConfig } from "../../../core/config.ts";
import { gitOk } from "../../../core/git.ts";
import {
  PERSONA_APPEND,
  createPearSession,
  maybeOnboardNavModel,
  resolveFlags,
  type PearSession,
} from "../../shared/pear-runtime.ts";
import { resolveNavComplete } from "../runtime.ts";

const NAV_TYPE = "pear-nav";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("nav-model", {
    description: "Navigator model provider/id (overrides any saved pear config)",
    type: "string",
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

  pi.registerMessageRenderer(NAV_TYPE, (message, _options, theme) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    return new Text(theme.fg("accent", text), 0, 0);
  });

  // Findings are human-only: strip them before the message list reaches the LLM.
  // omp's convertMessageToLlm turns every surviving `role: "custom"` message into
  // a `developer` message regardless of `display`, so without this filter the
  // navigator's review text would leak into the model's context on the next turn.
  pi.on("context", async (event) => ({
    messages: event.messages.filter(
      (m) => !(m.role === "custom" && m.customType === NAV_TYPE),
    ),
  }));

  let session: PearSession | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const homeDir = homedir();
    const cliNavModel = pi.getFlag("nav-model");
    const noNav = Boolean(pi.getFlag("no-nav"));
    const preference = resolveNavModelPreference(ctx.cwd, homeDir);
    const onboarded = await maybeOnboardNavModel({
      ui: {
        select: (title, choices) => ctx.ui.select(title, choices),
        notify: (message, type) => ctx.ui.notify(message, type),
      },
      hasUI: ctx.hasUI,
      isGit: gitOk(ctx.cwd),
      noNav,
      cliOverride: cliNavModel !== undefined,
      hasPreference: preference !== undefined,
      availableModels: ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
      save: (cfg) => saveUserConfig(homeDir, cfg),
    });
    const flags = resolveFlags((name) => pi.getFlag(name), onboarded ?? preference ?? DEFAULTS.navModel);
    const complete = await resolveNavComplete(ctx.modelRegistry, flags.navModel, completeSimple);

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
      onFindings: (text) =>
        pi.sendMessage(
          { customType: NAV_TYPE, content: text, display: true },
          { triggerTurn: false },
        ),
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
    return { systemPrompt: [...event.systemPrompt, PERSONA_APPEND] };
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

  pi.registerCommand("pear-setup", {
    description: "Choose pear's navigator model",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pear-setup requires an interactive session", "warning");
        return;
      }
      const choice = await ctx.ui.select(
        "Pick a model for pear's navigator:",
        ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
      );
      if (!choice) return;
      saveUserConfig(homedir(), { navModel: choice });
      ctx.ui.notify(`pear: navigator model set to ${choice}. Run /reload to apply.`, "info");
    },
  });
}
