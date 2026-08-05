import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureModelsConfigured, type ModelPickerUi } from "../adapters/shared/pear-runtime.ts";
import { DEFAULTS, type PearConfig } from "../core/config.ts";

function fakeUi(selectResult: string | undefined) {
  const notifies: Array<{ message: string; type?: string }> = [];
  const selects: Array<{ title: string; choices: string[] }> = [];
  const ui: ModelPickerUi = {
    select: async (title, choices) => {
      selects.push({ title, choices });
      return selectResult;
    },
    notify: (message, type) => notifies.push({ message, type }),
  };
  return { ui, notifies, selects };
}

const cfg = (over: Partial<Required<PearConfig>> = {}): Required<PearConfig> => ({
  mode: "human-driver",
  reviewModel: DEFAULTS.reviewModel,
  filterModel: DEFAULTS.filterModel,
  minLines: DEFAULTS.minLines,
  debounceSeconds: DEFAULTS.debounceSeconds,
  intervalSeconds: DEFAULTS.intervalSeconds,
  checkpointSeconds: DEFAULTS.checkpointSeconds,
  maxChangesPerCheckpoint: DEFAULTS.maxChangesPerCheckpoint,
  ...over,
});

describe("ensureModelsConfigured gating", () => {
  it("agent-driver has no model requirement, even with empty model fields", async () => {
    const { ui } = fakeUi(undefined);
    const result = await ensureModelsConfigured(
      "agent-driver",
      cfg({ reviewModel: "", filterModel: "" }),
      ui,
      [],
      true,
    );
    assert.deepEqual(result, { ok: true, patch: {} });
  });

  it("off has no model requirement", async () => {
    const { ui } = fakeUi(undefined);
    const result = await ensureModelsConfigured("off", cfg(), ui, [], true);
    assert.deepEqual(result, { ok: true, patch: {} });
  });

  it("human-driver with both models already set returns ok with an empty patch, no prompt", async () => {
    const { ui, selects } = fakeUi(undefined);
    const result = await ensureModelsConfigured("human-driver", cfg(), ui, ["a/b"], true);
    assert.deepEqual(result, { ok: true, patch: {} });
    assert.equal(selects.length, 0);
  });
});

describe("ensureModelsConfigured with UI", () => {
  it("prompts only for the missing model field using the exact titles", async () => {
    const { ui, selects } = fakeUi("anthropic/claude-sonnet-4-5");
    const result = await ensureModelsConfigured(
      "human-driver",
      cfg({ filterModel: "" }),
      ui,
      ["anthropic/claude-sonnet-4-5"],
      true,
    );
    assert.deepEqual(result, { ok: true, patch: { filterModel: "anthropic/claude-sonnet-4-5" } });
    assert.equal(selects.length, 1);
    assert.match(selects[0]!.title, /filter model/);
    assert.deepEqual(selects[0]!.choices, ["anthropic/claude-sonnet-4-5"]);
  });

  it("prompts for both missing fields using the exact review/filter titles", async () => {
    const { ui, selects } = fakeUi("openai/gpt-test");
    const result = await ensureModelsConfigured(
      "human-driver",
      cfg({ reviewModel: "", filterModel: "" }),
      ui,
      ["openai/gpt-test"],
      true,
    );
    assert.deepEqual(result, {
      ok: true,
      patch: { reviewModel: "openai/gpt-test", filterModel: "openai/gpt-test" },
    });
    assert.equal(selects.length, 2);
    assert.match(selects[0]!.title, /review model/);
    assert.match(selects[1]!.title, /filter model/);
  });

  it("fails when the selection is dismissed", async () => {
    const { ui } = fakeUi(undefined);
    const result = await ensureModelsConfigured("human-driver", cfg({ reviewModel: "" }), ui, ["a/b"], true);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /reviewModel and filterModel/);
  });
});

describe("ensureModelsConfigured headless", () => {
  it("fails with a clear reason instead of prompting when a model is missing", async () => {
    const { ui, selects } = fakeUi(undefined);
    const result = await ensureModelsConfigured(
      "human-driver",
      cfg({ filterModel: "" }),
      ui,
      ["a/b"],
      false,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.reason,
        "human-driver needs reviewModel and filterModel set — run /pear-config first",
      );
    }
    assert.equal(selects.length, 0);
  });

  it("succeeds headless when both models are already set", async () => {
    const { ui } = fakeUi(undefined);
    const result = await ensureModelsConfigured("human-driver", cfg(), ui, [], false);
    assert.deepEqual(result, { ok: true, patch: {} });
  });
});
