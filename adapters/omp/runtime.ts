import { parseModel } from "../../core/config.ts";
import type { Complete } from "../../core/llm.ts";

export * from "../shared/pear-runtime.ts";

export type OmpAuth = {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
};

export type OmpModelRegistry<TModel> = {
  find: (provider: string, modelId: string) => TModel | undefined;
  getApiKeyAndHeaders: (model: TModel) => Promise<OmpAuth>;
};

/** Minimal shape of `@oh-my-pi/pi-ai`'s `completeSimple` that the navigator needs. */
export type OmpCompleteSimple<TModel> = (
  model: TModel,
  context: {
    systemPrompt?: string[];
    messages: Array<{ role: "user"; content: string; timestamp: number }>;
  },
  options?: { apiKey?: string; headers?: Record<string, string> },
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  stopReason: string;
  errorMessage?: string;
}>;

/** Build a Complete fn from omp's ModelRegistry + @oh-my-pi/pi-ai's completeSimple. */
export async function resolveNavComplete<TModel>(
  modelRegistry: OmpModelRegistry<TModel>,
  navModelSpec: string,
  completeSimple: OmpCompleteSimple<TModel>,
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

  return async (system, user) => {
    const message = await completeSimple(
      model,
      {
        systemPrompt: [system],
        messages: [{ role: "user", content: user, timestamp: Date.now() }],
      },
      { apiKey: auth.apiKey, headers: auth.headers },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "review failed");
    }
    return message.content
      .filter(
        (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string",
      )
      .map((c) => c.text)
      .join("");
  };
}
