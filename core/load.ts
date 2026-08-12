/**
 * Review load: how much reading a batch of changes costs a human.
 *
 * This replaces counting mutating tool calls. A raw call count is a bad proxy
 * for "how much is there to review" in both directions, and both directions
 * were observed in practice:
 *
 * - Five one-line edits to one file are one small change, but tripped a
 *   five-call budget.
 * - One `write` of a 400-line file is a lot to read, but counted as a single
 *   call and sailed through.
 *
 * So the unit is a point score combining *how many files* were touched with
 * *how many diff lines* the human would have to read.
 *
 * ## Where the numbers come from
 *
 * Estimates are derived from the tool **input**, not from git and not from the
 * tool result. That is deliberate:
 *
 * - It keeps git display-only, so a git failure can never wedge the loop.
 * - It works in a non-git directory.
 * - It needs no subprocess and no `await`, so the `tool_call` hook stays
 *   synchronous (see the "hooks decide synchronously" invariant).
 * - It is available *before* the call runs, which is when the gate is consulted.
 *
 * The cost is an estimate, not a measurement, and it errs toward more
 * oversight: an `edit` is charged for both sides of every hunk, because that is
 * what a diff shows; a `write` is charged for its whole content, because a
 * full-file overwrite must be re-read in full; and a mutating `bash` command,
 * whose effect cannot be read off its input at all, is charged a flat penalty
 * rather than nothing.
 *
 * Nothing here decides *whether* to check in — it only prices changes.
 * Thresholds live in `core/config.ts` and the tiering lives in the runtime.
 */

import { isReadOnlyBashCommand } from "./bash.ts";

/**
 * Charged once per distinct file in a review window.
 *
 * Sized so that touching a file is worth about as much attention as reading 40
 * lines of diff: switching files has a real cost that pure line counting
 * misses.
 */
export const FILE_POINTS = 40;

/**
 * Charged for a mutating `bash` call.
 *
 * We cannot tell what `bash` did from its input, and refusing to charge for it
 * would let an agent do unbounded work through the shell without ever tripping
 * the budget. Priced above `FILE_POINTS` because an unreadable change is worse
 * for the navigator than a readable one of the same size.
 */
export const OPAQUE_POINTS = 60;

export type ChangeCost = {
  /** Paths this call touches, exactly as the tool named them. */
  paths: string[];
  /** Diff lines a human would have to read for this call. */
  lines: number;
  /**
   * The call mutates something, but its cost could not be read off its input.
   * Charged `OPAQUE_POINTS` on top of anything else.
   */
  opaque: boolean;
};

/**
 * Lines in a string, counting a trailing newline as a terminator rather than a
 * line of its own. `""` is zero lines; `"a"` and `"a\n"` are both one.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n");
  // A trailing "\n" produces a final empty element that is not a line.
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

/** An input we could not read, for a tool we know mutates. Priced, not ignored. */
const UNREADABLE: ChangeCost = { paths: [], lines: 0, opaque: true };

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function editCost(input: unknown): ChangeCost {
  const rec = asRecord(input);
  if (rec === undefined || typeof rec.path !== "string" || !Array.isArray(rec.edits)) {
    return UNREADABLE;
  }
  let lines = 0;
  for (const hunk of rec.edits) {
    const h = asRecord(hunk);
    if (h === undefined) {
      // A hunk we cannot read means the whole estimate is untrustworthy.
      return { paths: [rec.path], lines: 0, opaque: true };
    }
    // Both sides, because a diff shows both. Missing sides count as zero
    // rather than making the call opaque: an empty side is legitimate
    // (pure insertion or pure deletion).
    if (typeof h.oldText === "string") lines += countLines(h.oldText);
    if (typeof h.newText === "string") lines += countLines(h.newText);
  }
  return { paths: [rec.path], lines, opaque: false };
}

function writeCost(input: unknown): ChangeCost {
  const rec = asRecord(input);
  if (rec === undefined || typeof rec.path !== "string") return UNREADABLE;
  // A write with no readable content still changed a file. Charge the file and
  // flag it rather than pricing it at zero.
  if (typeof rec.content !== "string") {
    return { paths: [rec.path], lines: 0, opaque: true };
  }
  return { paths: [rec.path], lines: countLines(rec.content), opaque: false };
}

function bashCost(input: unknown): ChangeCost | undefined {
  const rec = asRecord(input);
  if (rec === undefined || typeof rec.command !== "string") return UNREADABLE;
  // Read-only commands are not changes at all, so they are not priced.
  // `isReadOnlyBashCommand` rejects anything it cannot trivially prove safe,
  // so "unclassifiable" already lands on the mutating side.
  return isReadOnlyBashCommand(rec.command) ? undefined : { paths: [], lines: 0, opaque: true };
}

/**
 * Price one tool call, or return `undefined` if it does not mutate anything.
 *
 * This is also the single source of truth for "is this tool mutating" — callers
 * should test for `undefined` rather than keeping their own tool-name set.
 */
export function estimateChange(toolName: string, input: unknown): ChangeCost | undefined {
  switch (toolName) {
    case "edit":
      return editCost(input);
    case "write":
      return writeCost(input);
    case "bash":
      return bashCost(input);
    default:
      return undefined;
  }
}

/**
 * Points for a cost, given how many of its paths are being touched for the
 * first time in the current review window.
 *
 * `firstTouches` is supplied by the caller because "first" is a property of the
 * window, not of the call: re-editing a file already counted this window costs
 * only its lines, which is what stops an iterative loop on one file from
 * inflating the score.
 */
export function pointsFor(cost: ChangeCost, firstTouches: number): number {
  return firstTouches * FILE_POINTS + cost.lines + (cost.opaque ? OPAQUE_POINTS : 0);
}

/**
 * Price a whole working tree, for human-driver.
 *
 * When the human is driving there are no tool calls to price, so the load comes
 * from git instead (`changedLineStats` in `core/git.ts`). The weights are
 * deliberately **the same** as `pointsFor`: one `reviewBudget` then serves both
 * drivers, and the two can never disagree about what "a lot to read" means.
 *
 * Both sides of the diff count, for the same reason an `edit` charges both
 * `oldText` and `newText` — a diff shows both.
 */
export function pointsForWorkingTree(stats: {
  files: number;
  insertions: number;
  deletions: number;
}): number {
  return stats.files * FILE_POINTS + stats.insertions + stats.deletions;
}
