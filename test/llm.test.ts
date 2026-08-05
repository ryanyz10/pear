import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runReview } from "../core/llm.ts";

const candidate = { file: "a.ts", line: 1, issue: "real", size: "medium", confidence: "high" };
const noise = { file: "b.ts", line: 2, issue: "noise", size: "small", confidence: "low" };

describe("runReview", () => {
  it("passes REVIEW_SYSTEM+diff to completeSmall and FILTER_SYSTEM+diff+candidates to completeLarge", async () => {
    let smallSystem = "";
    let smallUser = "";
    let largeSystem = "";
    let largeUser = "";
    const { kept, filtered } = await runReview(
      async (system, user) => {
        smallSystem = system;
        smallUser = user;
        return JSON.stringify([candidate, noise]);
      },
      async (system, user) => {
        largeSystem = system;
        largeUser = user;
        return JSON.stringify([candidate]);
      },
      "@@ -1 +1 @@\n+hello",
    );
    assert.match(smallSystem, /code navigator/i);
    assert.match(smallUser, /@@ -1 \+1 @@/);
    assert.match(largeSystem, /senior reviewer/i);
    assert.match(largeUser, /@@ -1 \+1 @@/);
    assert.match(largeUser, /"issue":"real"/);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.issue, "real");
    assert.equal(filtered, 1);
  });

  it("short-circuits without calling completeLarge when completeSmall finds nothing", async () => {
    const { kept, filtered } = await runReview(
      async () => "[]",
      async () => {
        throw new Error("completeLarge must not be called with zero candidates");
      },
      "diff",
    );
    assert.equal(kept.length, 0);
    assert.equal(filtered, 0);
  });

  it("drops a finding invented by the filter model that was not among the candidates", async () => {
    const invented = { file: "z.ts", line: 9, issue: "made up", size: "large", confidence: "high" };
    const { kept, filtered } = await runReview(
      async () => JSON.stringify([candidate]),
      async () => JSON.stringify([candidate, invented]),
      "diff",
    );
    assert.deepEqual(kept, [candidate]);
    assert.equal(filtered, 0);
  });

  it("propagates parse errors from completeSmall", async () => {
    await assert.rejects(
      () => runReview(async () => "not json", async () => "[]", "d"),
      /not a JSON array|malformed/,
    );
  });

  it("propagates parse errors from completeLarge", async () => {
    await assert.rejects(
      () => runReview(async () => JSON.stringify([candidate]), async () => "not json", "d"),
      /not a JSON array|malformed/,
    );
  });
});
