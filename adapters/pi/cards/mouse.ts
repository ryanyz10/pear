/**
 * Parse mouse-wheel reports already supplied by pi's fullscreen TUI.
 *
 * pear never enables terminal mouse reporting. Regular TUI cards render their
 * complete body into native terminal scrollback, so the terminal owns the
 * wheel. Fullscreen pi has no native scrollback and already requests SGR mouse
 * reports; a focused card receives those reports as raw input and uses this
 * parser to move its body window.
 */

/** An SGR mouse report: `ESC [ < button ; col ; row (M|m)`. */
const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

/** The wheel sets bit 6; bits 2-4 are shift/alt/ctrl modifiers. */
const WHEEL_BIT = 64;
/** Within a wheel report, bit 0 clear is up and set is down. */
const DOWN_BIT = 1;

export type WheelDirection = "up" | "down";

/** Read a wheel event out of raw input, or `undefined` for anything else. */
export function parseWheel(data: string): WheelDirection | undefined {
  const match = SGR_MOUSE.exec(data);
  if (match === null) return undefined;
  const button = Number(match[1]);
  if (!Number.isFinite(button) || (button & WHEEL_BIT) === 0) return undefined;
  return (button & DOWN_BIT) === 0 ? "up" : "down";
}
