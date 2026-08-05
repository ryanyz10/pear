import { loadState, saveState, settle } from "../_vendor/adapters/shared/hook-checkpoint.ts";
import {
  readStdinJson,
  resolveCallId,
  resolveCwd,
  resolveToolName,
  isMutatingTool,
  writeJson,
} from "../_vendor/adapters/shared/hook-io.ts";
import { drainFindings } from "../_vendor/adapters/shared/daemon.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
const toolName = resolveToolName(body);

if (isMutatingTool(toolName)) {
  let state = loadState(cwd);
  const ok = body.hook_event_name !== "PostToolUseFailure";
  state = settle(state, resolveCallId(body), ok);
  saveState(cwd, state);
}

const findings = drainFindings(cwd).trim();
writeJson(findings ? { systemMessage: findings } : {});
