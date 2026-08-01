import { readStdinJson, resolveCwd, writeJson } from "../../shared/hook-io.ts";
import { stopDaemon } from "../../shared/daemon.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
stopDaemon(cwd);
writeJson({});
