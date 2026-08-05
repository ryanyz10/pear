import { gateTool } from "../_vendor/adapters/shared/hook-checkpoint.ts";
import {
  isMutatingTool,
  readStdinJson,
  resolveCallId,
  resolveCwd,
  resolveToolInput,
  resolveToolName,
  writeJson,
} from "../_vendor/adapters/shared/hook-io.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);
const toolName = resolveToolName(body);

if (!isMutatingTool(toolName)) {
  writeJson({});
  process.exit(0);
}

const gate = gateTool(cwd, {
  callId: resolveCallId(body),
  toolName,
  input: resolveToolInput(body),
});

if (gate.action === "deny") {
  writeJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: gate.block,
    },
  });
} else {
  writeJson({});
}
