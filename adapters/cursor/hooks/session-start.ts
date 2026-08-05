import { readStdinJson, resolveCwd, writeJson } from "../../shared/hook-io.ts";
import { spawnDaemon } from "../../shared/daemon.ts";
import { gitOk } from "../../../core/git.ts";
import { resolveNavModelPreference } from "../../../core/config.ts";
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
          "pear: no navigator model configured — run `node --experimental-strip-types /path/to/pear/adapters/shared/setup.ts` (or `npm run setup` from your pear checkout) to pick one. Using the default model for now.",
      }
    : {},
);
