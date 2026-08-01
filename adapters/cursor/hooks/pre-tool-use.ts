import { gateTool } from "../../shared/hook-checkpoint.ts";
import {
  isMutatingTool,
  readStdinJson,
  resolveCallId,
  resolveCwd,
  resolveToolInput,
  resolveToolName,
  writeJson,
} from "../../shared/hook-io.ts";
import { drainFindings } from "../../shared/daemon.ts";

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
  const findings = drainFindings(cwd).trim();
  const userMessage = findings ? `${findings}\n\n${gate.summary}` : gate.summary;
  writeJson({
    permission: "deny",
    user_message: userMessage,
    agent_message: gate.block,
    failClosed: false,
  });
} else {
  writeJson({});
}
