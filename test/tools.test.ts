import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { overBudget, shouldReview } from "../src/config.ts";

describe("overBudget", () => {
  const cfg = { pauseLines: 150, pauseEdits: 5 };

  it("is false at baseline", () => {
    assert.equal(overBudget({ lines: 10, mutations: 1 }, { lines: 10, mutations: 1 }, cfg), false);
  });

  it("trips on line growth", () => {
    assert.equal(overBudget({ lines: 160, mutations: 1 }, { lines: 10, mutations: 1 }, cfg), true);
  });

  it("trips on mutation growth", () => {
    assert.equal(overBudget({ lines: 10, mutations: 6 }, { lines: 10, mutations: 1 }, cfg), true);
  });

  it("resets after baseline moves", () => {
    const cur = { lines: 200, mutations: 10 };
    assert.equal(overBudget(cur, { lines: 50, mutations: 5 }, cfg), true);
    assert.equal(overBudget(cur, cur, cfg), false);
  });

  it("single mutation crossing mid-turn", () => {
    // Was under; one mutation pushes edits over.
    assert.equal(overBudget({ lines: 20, mutations: 5 }, { lines: 0, mutations: 0 }, cfg), true);
  });
});

describe("shouldReview", () => {
  const cfg = { minLines: 50, intervalSeconds: 60 };

  it("blocks below min lines", () => {
    const g = shouldReview(10, 0, 1000, cfg);
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.reason, "lines");
  });

  it("blocks within interval", () => {
    const g = shouldReview(100, 1000, 1000 + 30_000, cfg);
    assert.equal(g.ok, false);
    if (!g.ok) {
      assert.equal(g.reason, "interval");
      assert.ok((g.waitMs ?? 0) > 0);
    }
  });

  it("passes when both clear", () => {
    assert.equal(shouldReview(100, 0, 1000, cfg).ok, true);
    assert.equal(shouldReview(100, 1000, 1000 + 60_000, cfg).ok, true);
  });
});
