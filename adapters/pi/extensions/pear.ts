import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import {
  loadUserConfig,
  resolveConfig,
  saveUserConfig,
  type Mode,
  type PearConfig,
} from "../../../core/config.ts";
import {
  createPearSession,
  ensureModelsConfigured,
  resolveNavComplete,
  type Complete,
  type PearSession,
  type ReviewCompletions,
} from "../runtime.ts";

type FindingsData = { lines: string };
type ConfigField =
  | "mode"
  | "reviewModel"
  | "filterModel"
  | "checkpointModel"
  | "minLines"
  | "debounceSeconds"
  | "intervalSeconds"
  | "checkpointSeconds"
  | "maxChangesPerCheckpoint";

const MODES = ["off", "human-driver", "agent-driver"] as const;
const NUMERIC_FIELDS: readonly ConfigField[] = [
  "minLines",
  "debounceSeconds",
  "intervalSeconds",
  "checkpointSeconds",
  "maxChangesPerCheckpoint",
];

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<FindingsData>("pear-nav", (entry, _opts, theme) => {
    const lines = entry.data?.lines ?? "";
    return new Text(theme.fg("accent", lines), 0, 0);
  });

  let session: PearSession | null = null;

  async function resolveCompletions(
    cfg: Required<PearConfig>,
    ctx: { modelRegistry: Parameters<typeof resolveNavComplete>[0] },
  ): Promise<ReviewCompletions> {
    const [small, large] = await Promise.all([
      resolveNavComplete(ctx.modelRegistry, cfg.reviewModel, streamSimple as any),
      resolveNavComplete(ctx.modelRegistry, cfg.filterModel, streamSimple as any),
    ]);
    return { small, large };
  }

  async function resolveCheckpointJudge(
    cfg: Required<PearConfig>,
    ctx: { modelRegistry: Parameters<typeof resolveNavComplete>[0] },
  ): Promise<Complete | null> {
    if (!cfg.checkpointModel) return null;
    // Best-effort: agent-driver never requires a model, so a registry/auth
    // exception here must degrade to today's deterministic behavior, not
    // crash session startup/mode switching.
    try {
      return await resolveNavComplete(ctx.modelRegistry, cfg.checkpointModel, streamSimple as any);
    } catch {
      return null;
    }
  }

  async function applyMode(
    target: Mode,
    ctx: {
      cwd: string;
      hasUI: boolean;
      ui: {
        select: (t: string, c: string[]) => Promise<string | undefined>;
        notify: (m: string, ty?: "info" | "warning" | "error") => void;
      };
      modelRegistry: Parameters<typeof resolveNavComplete>[0] & {
        getAvailable: () => Array<{ provider: string; id: string }>;
      };
    },
  ): Promise<void> {
    const homeDir = homedir();
    if (target === "human-driver") {
      const cfgNow = resolveConfig(ctx.cwd, homeDir);
      const availableModels = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      const result = await ensureModelsConfigured(
        "human-driver",
        cfgNow,
        { select: ctx.ui.select, notify: ctx.ui.notify },
        availableModels,
        ctx.hasUI,
      );
      if (!result.ok) {
        ctx.ui.notify(result.reason, "error");
        return;
      }
      saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), ...result.patch, mode: "human-driver" });
      const resolvedCfg = resolveConfig(ctx.cwd, homeDir);
      const completions = await resolveCompletions(resolvedCfg, ctx);
      if (!completions.small || !completions.large) {
        ctx.ui.notify("pear: could not resolve reviewModel/filterModel — mode unchanged", "error");
        return;
      }
      session?.setMode("human-driver", resolvedCfg, completions);
    } else {
      saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), mode: target });
      const resolvedCfg = resolveConfig(ctx.cwd, homeDir);
      const checkpointJudge = target === "agent-driver" ? await resolveCheckpointJudge(resolvedCfg, ctx) : null;
      session?.setMode(target, resolvedCfg, { small: null, large: null, checkpointJudge });
    }
    ctx.ui.notify(`pear: mode set to ${target}`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    const homeDir = homedir();
    const cfg = resolveConfig(ctx.cwd, homeDir);

    let completions: ReviewCompletions = { small: null, large: null, checkpointJudge: null };
    if (cfg.mode === "human-driver") {
      const { small, large } = await resolveCompletions(cfg, ctx);
      completions = { small, large, checkpointJudge: null };
      if (!small || !large) {
        ctx.ui.notify(
          "pear: human-driver needs reviewModel and filterModel available — check /pear-config",
          "warning",
        );
      }
    } else if (cfg.mode === "agent-driver") {
      completions = { small: null, large: null, checkpointJudge: await resolveCheckpointJudge(cfg, ctx) };
    }

    session = createPearSession({
      cwd: ctx.cwd,
      cfg,
      completions,
      ui: {
        hasUI: ctx.hasUI,
        notify: (message, type) => ctx.ui.notify(message, type),
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
      },
      onFindings: (text) => pi.appendEntry<FindingsData>("pear-nav", { lines: text }),
      sendUserMessage: (text) => pi.sendUserMessage(text),
      saveConfig: (patch) => saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), ...patch }),
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

  pi.on("tool_call", async (event, ctx) => {
    if (!session) return undefined;
    const decision = await session.onToolCall({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
    });
    if (decision?.block) ctx.abort();
    return decision;
  });

  pi.on("tool_result", (event) => {
    session?.onToolResult(event.toolCallId, event.isError);
  });

  pi.registerCommand("pear-status", {
    description: "Show pear's mode, checkpoint, and scheduler status",
    handler: async (_args, ctx) => {
      const text = session?.statusText() ?? "pear: off — /pear-mode to start";
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("pear-mode", {
    description: "Switch pear's mode: off | human-driver | agent-driver",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed !== "" && !(MODES as readonly string[]).includes(trimmed)) {
        ctx.ui.notify(`pear: unknown mode "${trimmed}" — expected off, human-driver, or agent-driver`, "error");
        return;
      }
      let target: Mode;
      if (trimmed === "") {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "pear-mode requires a mode name in headless sessions: off | human-driver | agent-driver",
            "warning",
          );
          return;
        }
        const choice = await ctx.ui.select("Pick pear's mode:", [...MODES]);
        if (choice === undefined) return;
        target = choice as Mode;
      } else {
        target = trimmed as Mode;
      }
      await applyMode(target, ctx);
    },
  });

  pi.registerCommand("pear-config", {
    description: "Adjust pear's mode, models, and cadence",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("edit .pear/config.json directly, or run npm run setup", "warning");
        return;
      }
      const homeDir = homedir();
      const cfgNow = resolveConfig(ctx.cwd, homeDir);
      const entries: Array<{ key: ConfigField; label: string }> = [
        { key: "mode", label: `mode (${cfgNow.mode})` },
        { key: "reviewModel", label: `reviewModel (${cfgNow.reviewModel})` },
        { key: "filterModel", label: `filterModel (${cfgNow.filterModel})` },
        { key: "checkpointModel", label: `checkpointModel (${cfgNow.checkpointModel})` },
        ...NUMERIC_FIELDS.map((key) => ({ key, label: `${key} (${cfgNow[key]})` })),
      ];
      const choice = await ctx.ui.select(
        "Pick a field to change:",
        entries.map((e) => e.label),
      );
      if (choice === undefined) return;
      const field = entries.find((e) => e.label === choice)!.key;
      const availableModels = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);

      if (field === "mode") {
        const target = await ctx.ui.select("Pick pear's mode:", [...MODES]);
        if (target === undefined) return;
        await applyMode(target as Mode, ctx);
        return;
      }

      if (field === "reviewModel" || field === "filterModel") {
        const choiceModel = await ctx.ui.select(`Pick ${field}:`, availableModels);
        if (choiceModel === undefined) return;
        const candidateCfg: Required<PearConfig> = { ...cfgNow, [field]: choiceModel };
        if (candidateCfg.mode === "human-driver") {
          const completions = await resolveCompletions(candidateCfg, ctx);
          if (!completions.small || !completions.large) {
            ctx.ui.notify(`pear: could not resolve ${field}=${choiceModel} — not saved`, "error");
            return;
          }
          saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), [field]: choiceModel });
          session?.setMode("human-driver", candidateCfg, completions);
        } else {
          saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), [field]: choiceModel });
        }
        ctx.ui.notify(`pear: ${field} set to ${choiceModel}`, "info");
        return;
      }

      if (field === "checkpointModel") {
        const choiceModel = await ctx.ui.select(`Pick ${field}:`, availableModels);
        if (choiceModel === undefined) return;
        const candidateCfg: Required<PearConfig> = { ...cfgNow, checkpointModel: choiceModel };
        saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), checkpointModel: choiceModel });
        if (candidateCfg.mode === "agent-driver") {
          const checkpointJudge = await resolveCheckpointJudge(candidateCfg, ctx);
          if (!checkpointJudge) {
            ctx.ui.notify(
              `pear: saved checkpointModel=${choiceModel}, but it didn't resolve — checkpoints will keep pausing on cadence alone until it does`,
              "warning",
            );
          }
          session?.setMode("agent-driver", candidateCfg, { small: null, large: null, checkpointJudge });
        } else {
          ctx.ui.notify(`pear: checkpointModel set to ${choiceModel}`, "info");
        }
        return;
      }

      // Numeric field.
      const raw = await ctx.ui.input(`New value for ${field} (positive integer):`);
      if (raw === undefined) return;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        ctx.ui.notify(`pear: ${field} must be a positive integer`, "error");
        return;
      }
      const candidateCfg: Required<PearConfig> = { ...cfgNow, [field]: n };
      if (candidateCfg.mode === "human-driver") {
        const completions = await resolveCompletions(candidateCfg, ctx);
        if (!completions.small || !completions.large) {
          ctx.ui.notify(`pear: could not resolve reviewModel/filterModel — ${field} not saved`, "error");
          return;
        }
        saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), [field]: n });
        session?.setMode("human-driver", candidateCfg, completions);
      } else {
        saveUserConfig(ctx.cwd, { ...loadUserConfig(ctx.cwd), [field]: n });
        if (candidateCfg.mode === "agent-driver") {
          const checkpointJudge = await resolveCheckpointJudge(candidateCfg, ctx);
          session?.setMode("agent-driver", candidateCfg, { small: null, large: null, checkpointJudge });
        }
      }
      ctx.ui.notify(`pear: ${field} set to ${n}`, "info");
    },
  });
}
