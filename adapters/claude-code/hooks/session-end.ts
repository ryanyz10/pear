import { readStdinJson, resolveCwd, writeJson } from "../_vendor/adapters/shared/hook-io.ts";
import { stopDaemon } from "../_vendor/adapters/shared/daemon.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
stopDaemon(cwd);
writeJson({});
