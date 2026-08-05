import { readStdinJson, resolveCwd, writeJson } from "../_vendor/adapters/shared/hook-io.ts";
import { drainFindings } from "../_vendor/adapters/shared/daemon.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
const findings = drainFindings(cwd).trim();
writeJson(findings ? { systemMessage: findings } : {});
