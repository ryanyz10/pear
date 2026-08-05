import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maybeOnboardNavModel, ONBOARDING_SKIP, type OnboardingUi } from "../adapters/shared/pear-runtime.ts";
import { DEFAULTS } from "../core/config.ts";

function fakeUi(selectResult: string | undefined) {
  const notifies: Array<{ message: string; type?: string }> = [];
  const selects: Array<{ title: string; choices: string[] }> = [];
  const ui: OnboardingUi = {
    select: async (title, choices) => {
      selects.push({ title, choices });
      return selectResult;
    },
    notify: (message, type) => notifies.push({ message, type }),
  };
  return { ui, notifies, selects };
}

function baseOpts(overrides: Partial<Parameters<typeof maybeOnboardNavModel>[0]> = {}) {
  const { ui } = fakeUi(undefined);
  return {
    ui,
    hasUI: true,
    isGit: true,
    noNav: false,
    cliOverride: false,
    hasPreference: false,
    availableModels: ["anthropic/claude-opus-4"],
    save: () => {},
    ...overrides,
  };
}

describe("maybeOnboardNavModel gating", () => {
  it("never prompts when hasUI is false", async () => {
    const { ui, selects } = fakeUi("anthropic/claude-opus-4");
    const result = await maybeOnboardNavModel(baseOpts({ ui, hasUI: false }));
    assert.equal(result, undefined);
    assert.equal(selects.length, 0);
  });

  it("never prompts when isGit is false", async () => {
    const { ui, selects } = fakeUi("anthropic/claude-opus-4");
    const result = await maybeOnboardNavModel(baseOpts({ ui, isGit: false }));
    assert.equal(result, undefined);
    assert.equal(selects.length, 0);
  });

  it("never prompts when noNav is true", async () => {
    const { ui, selects } = fakeUi("anthropic/claude-opus-4");
    const result = await maybeOnboardNavModel(baseOpts({ ui, noNav: true }));
    assert.equal(result, undefined);
    assert.equal(selects.length, 0);
  });

  it("never prompts when cliOverride is true", async () => {
    const { ui, selects } = fakeUi("anthropic/claude-opus-4");
    const result = await maybeOnboardNavModel(baseOpts({ ui, cliOverride: true }));
    assert.equal(result, undefined);
    assert.equal(selects.length, 0);
  });

  it("never prompts when hasPreference is true", async () => {
    const { ui, selects } = fakeUi("anthropic/claude-opus-4");
    const result = await maybeOnboardNavModel(baseOpts({ ui, hasPreference: true }));
    assert.equal(result, undefined);
    assert.equal(selects.length, 0);
  });
});

describe("maybeOnboardNavModel choice handling", () => {
  it("saves and returns the chosen model", async () => {
    const { ui, notifies, selects } = fakeUi("anthropic/claude-opus-4");
    let saved: { navModel: string } | undefined;
    const result = await maybeOnboardNavModel(
      baseOpts({ ui, save: (cfg) => (saved = cfg) }),
    );
    assert.equal(result, "anthropic/claude-opus-4");
    assert.deepEqual(saved, { navModel: "anthropic/claude-opus-4" });
    assert.equal(selects.length, 1);
    assert.equal(
      selects[0]!.title,
      "Pick a model for pear's navigator (reviews your uncommitted changes):",
    );
    assert.deepEqual(selects[0]!.choices, ["anthropic/claude-opus-4", ONBOARDING_SKIP]);
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0]!.type, "info");
  });

  it("persists DEFAULTS.navModel and returns it when the user picks skip", async () => {
    const { ui } = fakeUi(ONBOARDING_SKIP);
    let saved: { navModel: string } | undefined;
    const result = await maybeOnboardNavModel(
      baseOpts({ ui, save: (cfg) => (saved = cfg) }),
    );
    assert.equal(result, DEFAULTS.navModel);
    assert.deepEqual(saved, { navModel: DEFAULTS.navModel });
  });

  it("saves nothing and returns undefined when dismissed", async () => {
    const { ui } = fakeUi(undefined);
    let saveCalled = false;
    const result = await maybeOnboardNavModel(
      baseOpts({ ui, save: () => (saveCalled = true) }),
    );
    assert.equal(result, undefined);
    assert.equal(saveCalled, false);
  });

  it("returns the selected model, notifies an error, and does not throw when save fails", async () => {
    const { ui, notifies } = fakeUi("anthropic/claude-opus-4");
    const result = await maybeOnboardNavModel(
      baseOpts({
        ui,
        save: () => {
          throw new Error("disk full");
        },
      }),
    );
    assert.equal(result, "anthropic/claude-opus-4");
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0]!.type, "error");
    assert.match(notifies[0]!.message, /disk full/);
  });
});
