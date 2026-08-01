import { readStdinJson, resolveCwd, writeJson } from "../../shared/hook-io.ts";
import { spawnDaemon } from "../../shared/daemon.ts";
import { gitOk } from "../../../core/git.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);

if (gitOk(cwd)) {
  try {
    spawnDaemon({ cwd });
  } catch {
    /* already running or spawn failed */
  }
}

writeJson({});
