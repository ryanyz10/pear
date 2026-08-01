import { readStdinJson, resolveCwd, writeJson } from "../../shared/hook-io.ts";
import { drainFindings } from "../../shared/daemon.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
const findings = drainFindings(cwd).trim();
writeJson(findings ? { systemMessage: findings } : {});
