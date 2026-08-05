import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFindings } from "../core/review.ts";

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
