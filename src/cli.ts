#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { DEFAULTS, type Config } from "./config.ts";
import { isGitRepo } from "./git.ts";
import { runSession } from "./session.ts";

function positiveInt(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function help() {
  process.stdout.write(`pear — lean pair-programming harness

Usage: pear [dir] [options]

  Type a task at the prompt to drive (agent codes with checkpoints).
  Edit files yourself to get navigator reviews.

Options:
  --drive-model <provider/id>   default ${DEFAULTS.driveModel}
  --nav-model <provider/id>     default ${DEFAULTS.navModel}
  --pause-lines <n>             checkpoint after N new lines (default ${DEFAULTS.pauseLines})
  --pause-edits <n>             checkpoint after N mutations (default ${DEFAULTS.pauseEdits})
  --min-lines <n>               navigator min change size (default ${DEFAULTS.minLines})
  --debounce <seconds>          navigator quiet period (default ${DEFAULTS.debounceSeconds})
  --interval <seconds>          min seconds between reviews (default ${DEFAULTS.intervalSeconds})
  --no-nav                      disable navigator
  --help                        show this help

Commands in-session: /status  /quit
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "drive-model": { type: "string" },
      "nav-model": { type: "string" },
      "pause-lines": { type: "string" },
      "pause-edits": { type: "string" },
      "min-lines": { type: "string" },
      debounce: { type: "string" },
      interval: { type: "string" },
      "no-nav": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    help();
    return;
  }

  const cwd = resolve(positionals[0] ?? process.cwd());
  const isGit = isGitRepo(cwd);
  let noNav = Boolean(values["no-nav"]);
  if (!isGit && !noNav) {
    process.stderr.write("warn: not a git repo — navigator disabled, pacing uses mutation count only\n");
    noNav = true;
  }

  const cfg: Config = {
    cwd,
    driveModel: values["drive-model"] ?? DEFAULTS.driveModel,
    navModel: values["nav-model"] ?? DEFAULTS.navModel,
    pauseLines: positiveInt("pause-lines", values["pause-lines"], DEFAULTS.pauseLines),
    pauseEdits: positiveInt("pause-edits", values["pause-edits"], DEFAULTS.pauseEdits),
    minLines: positiveInt("min-lines", values["min-lines"], DEFAULTS.minLines),
    debounceSeconds: positiveInt("debounce", values.debounce, DEFAULTS.debounceSeconds),
    intervalSeconds: positiveInt("interval", values.interval, DEFAULTS.intervalSeconds),
    noNav,
    isGit,
  };

  await runSession(cfg);
}

main().catch((e) => {
  process.stderr.write(`pear: ${(e as Error).message}\n`);
  process.exit(1);
});
