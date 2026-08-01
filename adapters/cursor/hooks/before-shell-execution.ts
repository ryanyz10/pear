import { gateTool } from "../../shared/hook-checkpoint.ts";
import {
  readStdinJson,
  resolveCallId,
  resolveCwd,
  resolveToolInput,
  writeJson,
} from "../../shared/hook-io.ts";
import { drainFindings } from "../../shared/daemon.ts";

const body = await readStdinJson<Record<string, unknown>>();
const cwd = resolveCwd(body);

const gate = gateTool(cwd, {
  callId: resolveCallId(body),
  toolName: "bash",
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
