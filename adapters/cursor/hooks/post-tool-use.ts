import {
  finishRebaseIfNeeded,
  loadState,
  saveState,
  settle,
} from "../../shared/hook-checkpoint.ts";
import {
  isMutatingTool,
  readStdinJson,
  resolveCallId,
  resolveCwd,
  resolveToolName,
  writeJson,
} from "../../shared/hook-io.ts";
import { drainFindings } from "../../shared/daemon.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
const toolName = resolveToolName(body);

if (isMutatingTool(toolName)) {
  let state = loadState(cwd);
  state = settle(state, resolveCallId(body), !(body.is_error ?? body.isError));
  state = finishRebaseIfNeeded(cwd, state);
  saveState(cwd, state);
}

const findings = drainFindings(cwd).trim();
writeJson(findings ? { systemMessage: findings } : {});
