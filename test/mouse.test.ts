import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enableMouse,
  forceDisableMouse,
  mouseEnabled,
  parseWheel,
} from "../adapters/pi/cards/mouse.ts";

/**
 * The parser is pure and the mode-set sequences take their writer as a
 * parameter, so all of this runs without a terminal. That is the whole reason
 * the module is shaped this way: nothing else about mouse reporting can be
 * tested here, so the parts that *can* be are separated out.
 */

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

describe("mouse reporting lifecycle", () => {
  /** Collects what would have gone to the terminal. */
  const recorder = () => {
    const writes: string[] = [];
    return { writes, write: (d: string) => writes.push(d) };
  };

  it("turns reporting on and off around one card", () => {
    const { writes, write } = recorder();
    const release = enableMouse(write);
    assert.ok(mouseEnabled());
    assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1006h"]);

    release();
    assert.equal(mouseEnabled(), false);
    assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1006h", "\x1b[?1006l\x1b[?1000l"]);
  });

  it("is idempotent, so a double release cannot disable someone else's card", () => {
    const { writes, write } = recorder();
    const release = enableMouse(write);
    release();
    release();
    release();
    assert.equal(writes.length, 2, "one enable, one disable");
  });

  it("refcounts, so the first card to close does not switch it off under the second", () => {
    const { writes, write } = recorder();
    const first = enableMouse(write);
    const second = enableMouse(write);
    assert.equal(writes.length, 1, "already on; no second enable");

    first();
    assert.ok(mouseEnabled(), "the second card still wants it");
    assert.equal(writes.length, 1, "nothing disabled yet");

    second();
    assert.equal(mouseEnabled(), false);
    assert.equal(writes.length, 2);
  });

  it("force-disables regardless of who was holding it", () => {
    // The session_shutdown path: a card may still be mounted, because resolving
    // pear's pending promise does not dispose pi's component.
    const { writes, write } = recorder();
    enableMouse(write);
    enableMouse(write);
    forceDisableMouse(write);
    assert.equal(mouseEnabled(), false);
    assert.deepEqual(writes.at(-1), "\x1b[?1006l\x1b[?1000l");
  });

  it("force-disabling when nothing is on writes nothing", () => {
    // Otherwise a shutdown in a session that never showed a card would reach in
    // and change terminal state pear never set.
    const { writes, write } = recorder();
    forceDisableMouse(write);
    assert.deepEqual(writes, []);
  });

  it("leaves reporting off when the enable write fails", () => {
    // The sequence is written *before* the refcount moves, so a failed enable
    // cannot leave pear believing reporting is on when the terminal never got
    // the request — which would mean a later disable writing to a terminal pear
    // never changed.
    assert.throws(() =>
      enableMouse(() => {
        throw new Error("stdout closed");
      }),
    );
    assert.equal(mouseEnabled(), false);

    const { writes, write } = recorder();
    forceDisableMouse(write);
    assert.deepEqual(writes, [], "nothing to undo");
  });
});
