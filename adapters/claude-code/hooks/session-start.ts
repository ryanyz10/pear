import { readStdinJson, resolveCwd, writeJson } from "../_vendor/adapters/shared/hook-io.ts";
import { spawnDaemon } from "../_vendor/adapters/shared/daemon.ts";
import { gitOk } from "../_vendor/core/git.ts";
import { resolveConfig } from "../_vendor/core/config.ts";
import { homedir } from "node:os";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
const isGit = gitOk(cwd);
const cfg = isGit ? resolveConfig(cwd, homedir()) : null;

if (cfg?.mode === "human-driver") {
  try {
    spawnDaemon({ cwd });
  } catch {
    /* already running or spawn failed */
  }
}

const needsSetup = isGit && cfg?.mode === "off";
writeJson(
  needsSetup
    ? {
        systemMessage:
          'pear: no mode configured — run `node --experimental-strip-types "$CLAUDE_PLUGIN_ROOT/_vendor/adapters/shared/setup.ts"` to choose agent-driver or human-driver.',
      }
    : {},
);
