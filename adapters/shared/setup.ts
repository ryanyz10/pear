#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { DEFAULTS, parseModel, saveUserConfig, type PearConfig } from "../../core/config.ts";

function positiveInt(name: string, raw: string, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log("pear setup — choose pear's mode for this project.");
const modeAnswer = (
  await rl.question(`Mode: off | human-driver | agent-driver [${DEFAULTS.mode}]: `)
).trim();
const mode = (modeAnswer || DEFAULTS.mode) as PearConfig["mode"];
if (mode !== "off" && mode !== "human-driver" && mode !== "agent-driver") {
  rl.close();
  throw new Error(`invalid mode "${mode}"; expected off, human-driver, or agent-driver`);
}

const patch: PearConfig = { mode };

if (mode === "human-driver") {
  const reviewAnswer = (
    await rl.question(`Review model as provider/id, generates findings [${DEFAULTS.reviewModel}]: `)
  ).trim();
  const reviewModel = reviewAnswer || DEFAULTS.reviewModel;
  parseModel(reviewModel); // throws with a clear message on malformed input; non-zero exit
  patch.reviewModel = reviewModel;

  const filterAnswer = (
    await rl.question(`Filter model as provider/id, checks the findings [${DEFAULTS.filterModel}]: `)
  ).trim();
  const filterModel = filterAnswer || DEFAULTS.filterModel;
  parseModel(filterModel);
  patch.filterModel = filterModel;

  patch.minLines = positiveInt(
    "minLines",
    (await rl.question(`Min changed lines before a review fires [${DEFAULTS.minLines}]: `)).trim(),
    DEFAULTS.minLines,
  );
  patch.debounceSeconds = positiveInt(
    "debounceSeconds",
    (await rl.question(`Quiet seconds after the last edit before reviewing [${DEFAULTS.debounceSeconds}]: `)).trim(),
    DEFAULTS.debounceSeconds,
  );
  patch.intervalSeconds = positiveInt(
    "intervalSeconds",
    (await rl.question(`Min seconds between reviews [${DEFAULTS.intervalSeconds}]: `)).trim(),
    DEFAULTS.intervalSeconds,
  );
} else if (mode === "agent-driver") {
  patch.checkpointSeconds = positiveInt(
    "checkpointSeconds",
    (await rl.question(`Checkpoint cadence in seconds [${DEFAULTS.checkpointSeconds}]: `)).trim(),
    DEFAULTS.checkpointSeconds,
  );
  patch.maxChangesPerCheckpoint = positiveInt(
    "maxChangesPerCheckpoint",
    (
      await rl.question(`Max mutating tool calls per checkpoint [${DEFAULTS.maxChangesPerCheckpoint}]: `)
    ).trim(),
    DEFAULTS.maxChangesPerCheckpoint,
  );
}

rl.close();
saveUserConfig(process.cwd(), patch);
console.log(`Saved — pear will run in ${mode} mode for this project (.pear/config.json).`);
