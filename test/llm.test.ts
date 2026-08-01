import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runReview } from "../core/llm.ts";

describe("runReview", () => {
  it("parses and triages the complete() response", async () => {
    const { kept, filtered } = await runReview(async () => {
      return JSON.stringify([
        { file: "a.ts", line: 1, issue: "real", size: "medium", confidence: "high" },
        { file: "b.ts", line: 2, issue: "noise", size: "small", confidence: "low" },
      ]);
    }, "diff");
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.issue, "real");
    assert.equal(filtered, 1);
  });

  it("passes REVIEW_SYSTEM and the diff to complete()", async () => {
    let system = "";
    let user = "";
    await runReview(async (s, u) => {
      system = s;
      user = u;
      return "[]";
    }, "@@ -1 +1 @@\n+hello");
    assert.match(system, /code navigator/i);
    assert.match(user, /@@ -1 \+1 @@/);
  });

  it("propagates parse errors", async () => {
    await assert.rejects(
      () => runReview(async () => "not json", "d"),
      /not a JSON array|malformed/,
    );
  });
});
