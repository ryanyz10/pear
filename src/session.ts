import { createModels, type Models, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type { Config } from "./config.ts";
import { parseModel } from "./config.ts";
import { createDriver, type Driver } from "./drive.ts";
import { changedLines, diffText, stateHash } from "./git.ts";
import { createScheduler, type Scheduler } from "./navigate.ts";
import { formatFindings, parseFindings, REVIEW_SYSTEM, triage } from "./review.ts";
import { createUi, isCtrlC, type CheckpointResult, type CreateUiOpts, type Ui } from "./ui.ts";

export function createModelsRegistry(): Models {
  const models = createModels();
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(googleProvider());
  return models;
}

export function resolveModel(models: Models, spec: string): Model<any> {
  const { provider, id } = parseModel(spec);
  const m = models.getModel(provider, id);
  if (!m) {
    const known = models
      .getModels(provider)
      .map((x) => `${provider}/${x.id}`)
      .slice(0, 20);
    throw new Error(
      `Unknown model '${spec}'.` +
        (known.length ? ` Known for ${provider}: ${known.join(", ")}${known.length >= 20 ? "…" : ""}` : ` No models registered for provider '${provider}'.`),
    );
  }
  return m;
}

function mapCheckpoint(r: CheckpointResult): string {
  switch (r.kind) {
    case "continue":
      return "";
    case "skip":
      return "skipped";
    case "steer":
      return r.text;
    case "cancelled":
      return "session ending";
  }
}

export type RunTurnDeps = {
  scheduler: Scheduler | null;
  driver: Driver;
  ui: { setBusy(b: boolean): void; appendFindings(t: string): void; flush(): void };
  stateHash: () => string;
  isGit: boolean;
};

/** One agent turn: park → busy → prompt → guarded cleanup (mark/unpark/busy-off/flush). */
export async function runTurn(deps: RunTurnDeps, task: string): Promise<void> {
  deps.scheduler?.setAgentActive(true);
  deps.ui.setBusy(true);
  try {
    await deps.driver.prompt(task);
  } catch (e) {
    deps.ui.appendFindings(`error: ${(e as Error).message}`);
  } finally {
    if (deps.scheduler && deps.isGit) {
      try {
        deps.scheduler.markReviewed(deps.stateHash());
      } catch {
        /* git transient */
      }
    }
    try {
      deps.scheduler?.setAgentActive(false);
    } catch {
      /* */
    }
    try {
      deps.ui.setBusy(false);
    } catch {
      /* */
    }
    try {
      deps.ui.flush();
    } catch {
      /* */
    }
  }
}

export type SessionDeps = {
  exit?: (code: number) => void;
  createUi?: (opts?: CreateUiOpts) => Ui;
};

export async function runSession(cfg: Config, deps: SessionDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const makeUi = deps.createUi ?? createUi;

  const models = createModelsRegistry();
  const driveModel = resolveModel(models, cfg.driveModel);
  const navModel = cfg.noNav || !cfg.isGit ? null : resolveModel(models, cfg.navModel);

  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let driver: Driver | null = null;
  let scheduler: Scheduler | null = null;

  const ui = makeUi({
    header:
      `pear — pair programming\n` +
      `  drive: ${cfg.driveModel}` +
      (navModel ? `  nav: ${cfg.navModel}` : "  nav: off") +
      `\n  type a task to drive; edit files to get navigator reviews\n` +
      `  /status  /quit`,
  });

  const refreshStatus = () => {
    if (!scheduler) {
      ui.setStatus("nav: off");
      return;
    }
    const s = scheduler.isParked() ? "parked" : scheduler.getState().toLowerCase();
    ui.setStatus(`nav: ${s} | last: ${scheduler.getLastSummary()}`);
  };

  const emit = (text: string) => {
    if (shuttingDown) return;
    ui.appendFindings(text);
    refreshStatus();
  };

  if (navModel && cfg.isGit) {
    scheduler = createScheduler(
      {
        minLines: cfg.minLines,
        intervalSeconds: cfg.intervalSeconds,
        debounceSeconds: cfg.debounceSeconds,
      },
      {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        getChangedLines: () => changedLines(cfg.cwd),
        getDiffText: () => diffText(cfg.cwd),
        runReview: async (diff) => {
          try {
            const text = await reviewOnce(models, navModel, diff);
            const findings = parseFindings(text);
            const { kept, filtered } = triage(findings);
            emit(formatFindings(kept, filtered));
            return { ok: true };
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
        },
        onOutput: emit,
      },
    );

    pollTimer = setInterval(() => {
      if (shuttingDown || !scheduler) return;
      try {
        scheduler.notify(stateHash(cfg.cwd));
        refreshStatus();
      } catch {
        /* ignore transient git errors */
      }
    }, 2000);
  }

  driver = createDriver(
    {
      models,
      model: driveModel,
      toolsCtx: {
        cwd: cfg.cwd,
        isGit: cfg.isGit,
        budget: { pauseLines: cfg.pauseLines, pauseEdits: cfg.pauseEdits },
        askCheckpoint: async (summary) => mapCheckpoint(await ui.checkpoint(summary)),
      },
    },
    {
      onMessageStart: () => ui.appendAssistantStart(),
      onTextDelta: (d) => ui.appendAssistantDelta(d),
      onMessageEnd: () => ui.appendAssistantEnd(),
      onTool: (name, hint) => ui.appendTool(name, hint),
    },
  );

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pollTimer) clearInterval(pollTimer);
    scheduler?.stop();
    driver?.abort();
    ui.stop();
    exit(0);
  };

  ui.start();
  ui.addInputListener((data) => {
    if (isCtrlC(data)) {
      shutdown();
      return { consume: true };
    }
    return undefined;
  });
  process.stdin.on("end", shutdown);
  refreshStatus();

  while (!shuttingDown) {
    ui.flush();
    const line = (await ui.getTask()).trim();
    if (shuttingDown) break;
    if (!line) continue;
    if (line === "/quit" || line === "/exit") {
      shutdown();
      return;
    }
    if (line === "/status") {
      const s = scheduler
        ? `nav: ${scheduler.isParked() ? "parked" : scheduler.getState().toLowerCase()} | last: ${scheduler.getLastSummary()}`
        : "nav: off";
      ui.appendFindings(s);
      continue;
    }

    if (scheduler) {
      const wasPending =
        scheduler.getState() === "PENDING" || scheduler.getState() === "WAITING_INTERVAL";
      if (wasPending) {
        ui.appendFindings("(folding pending human edits into this turn — they'll show in checkpoints)");
      }
    }
    ui.setStatus("agent working…");
    await runTurn(
      {
        scheduler,
        driver: driver!,
        ui,
        stateHash: () => stateHash(cfg.cwd),
        isGit: cfg.isGit,
      },
      line,
    );
    refreshStatus();
  }
}

async function reviewOnce(models: Models, model: Model<any>, diff: string): Promise<string> {
  const stream = models.streamSimple(model, {
    systemPrompt: REVIEW_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Review this working-tree diff:\n\n${diff || "(empty diff)"}`,
        timestamp: Date.now(),
      },
    ],
  });
  let text = "";
  for await (const ev of stream) {
    if (ev.type === "text_delta") text += ev.delta;
    if (ev.type === "error") {
      throw new Error(ev.error.errorMessage ?? "review stream error");
    }
    if (ev.type === "done" && (ev.message.stopReason === "error" || ev.message.stopReason === "aborted")) {
      throw new Error(ev.message.errorMessage ?? "review failed");
    }
  }
  return text;
}
