/**
 * Mouse-wheel reporting for the card.
 *
 * ## Why this exists at all
 *
 * The card is a fullscreen overlay. pi composites overlays over the current
 * screen and writes nothing to the terminal's scrollback, so the terminal's own
 * wheel has nothing to scroll — the body past the first screenful is not in the
 * terminal at any point. Keys are one answer; this is the other, and it is the
 * one people reach for first.
 *
 * ## Why it is not simply an API call
 *
 * pi 0.83.0 has no mouse support to hook into: nothing in `pi-tui` enables
 * tracking or exposes an event. What it *does* have is the receiving half —
 * `stdin-buffer.js` recognises SGR mouse reports explicitly
 * (`/^<\d+;\d+;\d+[Mm]$/`), buffers them as complete sequences, and
 * `forwardInputSequence` hands them verbatim to the focused component's
 * `handleInput`. So the reports already arrive; nobody has asked the terminal
 * to send them.
 *
 * That makes this module two things pi does not do: the mode-set sequences, and
 * a parser. Writing terminal control sequences behind the host's back is real
 * coupling, and it is recorded in `docs/pi-api-notes.md` so it gets re-checked
 * when the pi pin moves.
 *
 * ## Why the teardown is redundant
 *
 * A terminal left in mouse-reporting mode is a genuinely bad outcome for the
 * human: clicking spews escape codes into their shell and native text selection
 * stops working until they run `reset`. It is not enough to disable on the
 * happy path, so disabling is idempotent and hangs off three separate hooks —
 * the card's own `dispose`, pear's `session_shutdown`, and process exit.
 * Enabling is refcounted for the same reason: two overlapping cards must not
 * let the first one to close turn reporting off under the second.
 */

/**
 * `1000` asks for button press/release reports, which is what carries the
 * wheel; `1006` selects SGR encoding, which is unambiguous and does not break
 * past column 223 the way the original encoding does. Motion reporting (`1002`,
 * `1003`) is deliberately not requested — the card only wants the wheel, and
 * motion would put a report on the wire for every pointer move.
 */
const ENABLE = "\x1b[?1000h\x1b[?1006h";

/** Unset in the reverse order, so the encoding outlives the reporting it decodes. */
const DISABLE = "\x1b[?1006l\x1b[?1000l";

/** An SGR mouse report: `ESC [ < button ; col ; row (M|m)`. */
const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

/**
 * The wheel sets bit 6. Bits 2-4 carry shift/alt/ctrl and are deliberately
 * ignored: a modifier held down while scrolling should still scroll.
 */
const WHEEL_BIT = 64;
/** Within a wheel report, bit 0 clear is up and set is down. */
const DOWN_BIT = 1;

export type WheelDirection = "up" | "down";

/**
 * Read a wheel event out of raw input, or `undefined` for anything that is not
 * one. Pure, so the whole encoding can be tested without a terminal — which
 * matters here because nothing else in this module can be.
 */
export function parseWheel(data: string): WheelDirection | undefined {
  const match = SGR_MOUSE.exec(data);
  if (match === null) return undefined;
  const button = Number(match[1]);
  if (!Number.isFinite(button) || (button & WHEEL_BIT) === 0) return undefined;
  return (button & DOWN_BIT) === 0 ? "up" : "down";
}

/** Where the sequences go. A parameter so tests never touch the real terminal. */
export type MouseWriter = (data: string) => void;

const writeToTerminal: MouseWriter = (data) => {
  try {
    process.stdout.write(data);
  } catch {
    // A closed or non-writable stdout means no mouse; it must never take the
    // card down with it.
  }
};

/** How many cards currently want reporting on. */
let holders = 0;
let exitHookInstalled = false;

/**
 * Turn on wheel reporting and return the function that turns it off again.
 *
 * The caller gets a release rather than a bare `disable`, so it cannot turn
 * reporting off on another card's behalf, and calling it twice is a no-op.
 */
export function enableMouse(write: MouseWriter = writeToTerminal): () => void {
  if (holders === 0) write(ENABLE);
  holders++;

  // Installed on first use rather than at import: a process that never shows a
  // card should not register a hook, and a hook that runs having never enabled
  // anything would be writing to someone else's terminal state.
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // `exit` only, and only a synchronous write: signal handlers would need to
    // decide whether to re-raise, and getting that wrong changes how pi exits.
    process.on("exit", () => {
      if (holders > 0) write(DISABLE);
      holders = 0;
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) write(DISABLE);
  };
}

/**
 * Turn reporting off regardless of who asked for it. For teardown paths that
 * outlive any individual card — a session shutdown can leave a card mounted,
 * because resolving pear's pending promise does not dispose pi's component.
 */
export function forceDisableMouse(write: MouseWriter = writeToTerminal): void {
  if (holders === 0) return;
  holders = 0;
  write(DISABLE);
}

/** Test seam: whether reporting is currently believed to be on. */
export function mouseEnabled(): boolean {
  return holders > 0;
}
