import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveNavComplete,
  type OmpAuth,
  type OmpCompleteSimple,
  type OmpModelRegistry,
} from "../adapters/omp/runtime.ts";

type FakeModel = { id: string };

const model: FakeModel = { id: "gpt-test" };

function registry(overrides: {
  find?: (provider: string, modelId: string) => FakeModel | undefined;
  auth?: OmpAuth;
}): OmpModelRegistry<FakeModel> {
  return {
    find: overrides.find ?? (() => model),
    getApiKeyAndHeaders: async () => overrides.auth ?? { ok: true, apiKey: "key" },
  };
}

const unreachable: OmpCompleteSimple<FakeModel> = async () => {
  throw new Error("should not be called");
};

describe("resolveNavComplete (omp)", () => {
  it("returns null for an unparsable model spec", async () => {
    assert.equal(await resolveNavComplete(registry({}), "not-a-model", unreachable), null);
  });

  it("returns null when the model is not found", async () => {
    const complete = await resolveNavComplete(
      registry({ find: () => undefined }),
      "openai/gpt-test",
      unreachable,
    );
    assert.equal(complete, null);
  });

  it("returns null when auth resolution fails", async () => {
    const complete = await resolveNavComplete(
      registry({ auth: { ok: false, error: "no auth" } }),
      "openai/gpt-test",
      unreachable,
    );
    assert.equal(complete, null);
  });

  it("returns null when auth succeeds without an api key", async () => {
    const complete = await resolveNavComplete(
      registry({ auth: { ok: true } }),
      "openai/gpt-test",
      unreachable,
    );
    assert.equal(complete, null);
  });

  it("passes the review system prompt and user diff through, joining text blocks", async () => {
    const complete = await resolveNavComplete(
      registry({}),
      "openai/gpt-test",
      async (m, context, options) => {
        assert.equal(m, model);
        assert.deepEqual(context.systemPrompt, ["sys"]);
        assert.equal(context.messages[0]?.content, "usr");
        assert.equal(options?.apiKey, "key");
        return {
          content: [
            { type: "text", text: "hello " },
            { type: "thinking" },
            { type: "text", text: "world" },
          ],
          stopReason: "stop",
        };
      },
    );
    assert.equal(typeof complete, "function");
    assert.equal(await complete!("sys", "usr"), "hello world");
  });

  it("throws with the provider error message when stopReason is error", async () => {
    const complete = await resolveNavComplete(registry({}), "openai/gpt-test", async () => ({
      content: [],
      stopReason: "error",
      errorMessage: "boom",
    }));
    await assert.rejects(() => complete!("sys", "usr"), /boom/);
  });

  it("throws a fallback message when aborted with no errorMessage", async () => {
    const complete = await resolveNavComplete(registry({}), "openai/gpt-test", async () => ({
      content: [],
      stopReason: "aborted",
    }));
    await assert.rejects(() => complete!("sys", "usr"), /review failed/);
  });
});
