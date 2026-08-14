import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWheel } from "../adapters/pi/cards/mouse.ts";

/** pi supplies these reports in fullscreen mode; the parser stays terminal-free. */

/** An SGR mouse report, as the terminal sends it. */
const report = (button: number, col = 10, row = 5, final = "M") =>
  `\x1b[<${button};${col};${row}${final}`;

describe("parseWheel", () => {
  it("reads the two wheel directions", () => {
    assert.equal(parseWheel(report(64)), "up");
    assert.equal(parseWheel(report(65)), "down");
  });

  it("ignores modifiers held while scrolling", () => {
    // Shift adds 4, alt 8, ctrl 16. Someone holding a key still means to scroll,
    // so the modifier bits must not stop the event being recognised.
    assert.equal(parseWheel(report(64 + 4)), "up");
    assert.equal(parseWheel(report(65 + 16)), "down");
    assert.equal(parseWheel(report(64 + 4 + 8 + 16)), "up");
  });

  it("ignores buttons that are not the wheel", () => {
    // 0/1/2 are left/middle/right press; the card has no use for them, and
    // treating a click as a scroll would be worse than ignoring it.
    for (const button of [0, 1, 2, 3, 32, 35]) {
      assert.equal(parseWheel(report(button)), undefined, `button ${button}`);
    }
  });

  it("accepts either terminator", () => {
    // Wheel reports use M, but a release-form m must not be mistaken for a
    // different event.
    assert.equal(parseWheel(report(64, 1, 1, "m")), "up");
  });

  it("reads position-independent reports", () => {
    // Column and row are parsed but unused: the card scrolls its whole body, so
    // where the pointer is does not change what happens.
    assert.equal(parseWheel(report(65, 200, 999)), "down");
  });

  it("returns undefined for anything that is not a mouse report", () => {
    for (const data of [
      "",
      "j",
      "\x1b",
      "\x1b[A", // arrow up
      "\x1b[5~", // page up
      "\x1b[<64;10;5", // truncated, no terminator
      "\x1b[<64;10M", // too few fields
      "\x1b[<;10;5M", // no button
      "\x1b[64;10;5M", // missing the SGR '<'
      "\x1b[<64;10;5X", // wrong terminator
      "prefix\x1b[<64;10;5M", // must match the whole sequence, not a substring
    ]) {
      assert.equal(parseWheel(data), undefined, JSON.stringify(data));
    }
  });
});
