import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFindings, triage, type Finding } from "../src/review.ts";

const f = (partial: Partial<Finding> & Pick<Finding, "size" | "confidence">): Finding => ({
  file: "a.ts",
  line: 1,
  issue: "x",
  ...partial,
});

describe("parseFindings", () => {
  it("parses a plain JSON array", () => {
    const got = parseFindings(`[{"file":"a.ts","line":3,"issue":"bug","size":"medium","confidence":"high"}]`);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.file, "a.ts");
  });

  it("extracts JSON from surrounding prose", () => {
    const got = parseFindings(`Here you go:\n[{"file":"a.ts","line":1,"issue":"x","size":"small","confidence":"low"}]\nThanks`);
    assert.equal(got.length, 1);
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => parseFindings("[{not json}]"), /malformed JSON/);
  });

  it("rejects wrong shape", () => {
    assert.throws(() => parseFindings(`{"file":"a"}`), /not a JSON array/);
    assert.throws(() => parseFindings(`[{"file":"a","line":"1","issue":"x","size":"small","confidence":"low"}]`), /line must be/);
    assert.throws(() => parseFindings(`[{"file":"a","line":1,"issue":"x","size":"tiny","confidence":"low"}]`), /invalid size/);
  });
});

describe("triage", () => {
  it("drops small+low only", () => {
    const all: Finding[] = [
      f({ size: "small", confidence: "low" }),
      f({ size: "small", confidence: "medium" }),
      f({ size: "medium", confidence: "low" }),
      f({ size: "large", confidence: "high" }),
    ];
    const { kept, filtered } = triage(all);
    assert.equal(filtered, 1);
    assert.equal(kept.length, 3);
    assert.ok(!kept.some((x) => x.size === "small" && x.confidence === "low"));
  });
});
