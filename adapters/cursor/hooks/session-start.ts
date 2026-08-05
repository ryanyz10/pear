import { readStdinJson, resolveCwd, writeJson } from "../../shared/hook-io.ts";
import { spawnDaemon } from "../../shared/daemon.ts";
import { gitOk } from "../../../core/git.ts";
import { resolveConfig } from "../../../core/config.ts";
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
          "pear: no mode configured — run `node --experimental-strip-types /path/to/pear/adapters/shared/setup.ts` (or `npm run setup` from your pear checkout) to choose agent-driver or human-driver.",
      }
    : {},
);
