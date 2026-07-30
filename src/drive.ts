import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import { createTools, type ToolsCtx } from "./tools.ts";

const SYSTEM = `You are pairing with a human. You are the DRIVER; they are the NAVIGATOR.
- Explain your reasoning concisely before each change.
- Prefer small, focused edits.
- When the human steers mid-tool with "NOT EXECUTED — human steering: …", treat that as direction and do not assume the tool ran.
- Be succinct.`;

export type DriverCallbacks = {
  onMessageStart: () => void;
  onTextDelta: (delta: string) => void;
  onMessageEnd: () => void;
  onTool: (name: string, hint: string) => void;
};

export type Driver = {
  prompt: (task: string) => Promise<void>;
  abort: () => void;
};

export function createDriver(
  opts: {
    models: Models;
    model: Model<any>;
    toolsCtx: ToolsCtx;
  },
  cb: DriverCallbacks,
): Driver {
  const toolbox = createTools(opts.toolsCtx);
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM,
      model: opts.model,
      thinkingLevel: "off",
      tools: toolbox.tools,
      messages: [],
    },
    streamFn: opts.models.streamSimple.bind(opts.models),
    toolExecution: "sequential",
  });

  agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      cb.onMessageStart();
    } else if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (e.type === "text_delta" && "delta" in e) {
        cb.onTextDelta(String((e as { delta: string }).delta));
      }
    } else if (event.type === "tool_execution_start") {
      const argHint =
        typeof event.args === "object" && event.args && "path" in event.args
          ? ` ${event.args.path}`
          : typeof event.args === "object" && event.args && "command" in event.args
            ? ` ${String(event.args.command).slice(0, 60)}`
            : "";
      cb.onTool(event.toolName, argHint);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      cb.onMessageEnd();
    }
  });

  return {
    prompt: async (task: string) => {
      await agent.prompt(task);
      await toolbox.maybeFinalCheckpoint();
    },
    abort: () => agent.abort(),
  };
}
