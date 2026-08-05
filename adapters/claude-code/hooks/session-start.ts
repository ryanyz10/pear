import { readStdinJson, resolveCwd, writeJson } from "../_vendor/adapters/shared/hook-io.ts";
import { spawnDaemon } from "../_vendor/adapters/shared/daemon.ts";
import { gitOk } from "../_vendor/core/git.ts";
import { resolveNavModelPreference } from "../_vendor/core/config.ts";
import { homedir } from "node:os";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
const isGit = gitOk(cwd);

if (isGit) {
  try {
    spawnDaemon({ cwd });
  } catch {
    /* already running or spawn failed */
  }
}

const needsSetup = isGit && resolveNavModelPreference(cwd, homedir()) === undefined;
writeJson(
  needsSetup
    ? {
        systemMessage:
          'pear: no navigator model configured — run `node --experimental-strip-types "$CLAUDE_PLUGIN_ROOT/_vendor/adapters/shared/setup.ts"` to pick one. Using the default model for now.',
      }
    : {},
);
