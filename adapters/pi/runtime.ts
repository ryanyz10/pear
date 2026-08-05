import { parseModel } from "../../core/config.ts";
import type { Complete } from "../../core/llm.ts";

export * from "../shared/pear-runtime.ts";

/** Build a Complete fn from pi modelRegistry + streamSimple. */
export async function resolveNavComplete(
  modelRegistry: {
    find: (provider: string, modelId: string) => unknown;
    getApiKeyAndHeaders: (model: any) => Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      error?: string;
    }>;
  },
  navModelSpec: string,
  streamSimple: (
    model: any,
    context: {
      systemPrompt?: string;
      messages: Array<{ role: "user"; content: string; timestamp: number }>;
    },
    options?: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> },
  ) => AsyncIterable<{
    type: string;
    delta?: string;
    error?: { errorMessage?: string };
    message?: { stopReason?: string; errorMessage?: string };
  }>,
): Promise<Complete | null> {
  let parsed: { provider: string; id: string };
  try {
    parsed = parseModel(navModelSpec);
  } catch {
    return null;
  }
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) return null;
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  return async (_system, user) => {
    // system is already REVIEW_SYSTEM from runReview; stream uses it as systemPrompt
    const stream = streamSimple(
      model,
      {
        systemPrompt: _system,
        messages: [{ role: "user", content: user, timestamp: Date.now() }],
      },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
    );
    let text = "";
    for await (const ev of stream) {
      if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      if (ev.type === "error") {
        throw new Error(ev.error?.errorMessage ?? "review stream error");
      }
      if (
        ev.type === "done" &&
        (ev.message?.stopReason === "error" || ev.message?.stopReason === "aborted")
      ) {
        throw new Error(ev.message?.errorMessage ?? "review failed");
      }
    }
    return text;
  };
}
