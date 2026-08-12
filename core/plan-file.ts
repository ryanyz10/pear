/**
 * Persisting the plan document to `.pear/plans/`.
 *
 * The plan is pear's own artifact — written by the extension, not by the
 * agent, whose tools stay read-only through scoping.
 *
 * ## One file per plan, named after itself
 *
 * A plan gets a filename the first time it is proposed —
 * `.pear/plans/wrap-the-sync-client-in-a-retry-3f9a2c.md` — and every later
 * revision of that same plan rewrites that same file. Approval rewrites it once
 * more with an `approved` header. So the directory reads as a list of things
 * that were planned, rather than one `latest.md` plus a pile of timestamps.
 *
 * The name has two halves because they answer different questions. The slug is
 * for the human scanning the directory a week later; it is derived from the
 * summary and nothing depends on it being unique or stable. The random id is
 * what makes the file *the* file: two plans opening with the same words do not
 * collide, and rewording a summary mid-revision cannot silently start writing
 * somewhere else — the caller holds the name from the first draft.
 *
 * Naming deliberately does not ask a model. A slug is not worth a network call
 * on the critical path of showing a card, and a plan that fails to save because
 * a provider hiccuped would be a worse trade than a slightly clumsy name.
 *
 * Nothing is written for a proposal nobody looked at, and nothing is deleted:
 * a superseded plan keeps its own file.
 *
 * Everything goes through an injectable fs seam, mirroring `core/config.ts`, so
 * the failure paths are testable without touching a real disk. Writes are plain
 * (not temp-file + rename) on purpose: a torn plan file is a regenerable
 * artifact, unlike config, so the atomicity machinery would protect nothing.
 */

import { join } from "node:path";
import type { ConfigFs } from "./config.ts";
import { formatPlan, type PlanSpec } from "./prompts.ts";

/** Draft or approved — the header says which, so the file can be read alone. */
export type PlanStatus = "draft" | "approved";

/** How much of the summary survives into the filename. */
const MAX_SLUG_LENGTH = 40;

export function plansDir(projectDir: string): string {
  return join(projectDir, ".pear", "plans");
}

/**
 * The readable half of the name: lowercase words from the summary, joined by
 * dashes, cut at a whole word where that is possible.
 *
 * Returns `"plan"` for a summary with nothing usable in it (punctuation, a
 * non-latin script, or empty), because a file still needs a name and the id
 * carries the identity anyway.
 */
export function slugifySummary(summary: string): string {
  const words = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (words === "") return "plan";
  if (words.length <= MAX_SLUG_LENGTH) return words;
  const cut = words.slice(0, MAX_SLUG_LENGTH);
  const lastDash = cut.lastIndexOf("-");
  // Prefer a whole word, but not at the cost of a two-letter slug.
  return (lastDash > MAX_SLUG_LENGTH / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/** Six base36 characters, which is plenty to keep two plans apart by eye. */
export function randomPlanId(random: () => number = Math.random): string {
  return Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
}

/**
 * The filename for a new plan. Called **once**, when a plan is first proposed;
 * the caller holds the result for the rest of the scoping round so that
 * revisions rewrite the same file.
 */
export function planFileName(summary: string, random: () => number = Math.random): string {
  return `${slugifySummary(summary)}-${randomPlanId(random)}.md`;
}

/** Where a named plan file lives. */
export function planPath(projectDir: string, fileName: string): string {
  return join(plansDir(projectDir), fileName);
}

/**
 * The saved file. `formatPlan` is the single renderer for card, persona, and
 * disk, so the saved document cannot drift from what the model is reminded of.
 * The header carries the status and the write time, because a file that is
 * rewritten in place has no other way to say which it is.
 */
export function renderPlanMarkdown(plan: PlanSpec, at: number, status: PlanStatus): string {
  const stamp = new Date(at).toISOString();
  const label = status === "approved" ? "approved" : "draft";
  return `# pear plan · ${label} · ${stamp}\n\n${formatPlan(plan)}\n`;
}

/**
 * Persist a proposal to its own file, creating `.pear/plans/` if needed.
 *
 * @param fileName the name assigned when this plan was first proposed. Passing
 *   a fresh name for a revision would scatter one plan across several files,
 *   which is the thing this module exists to stop.
 * @returns the path written, so the caller can tell the human where it is.
 * @throws when the directory or file cannot be written — the caller surfaces
 *   the failure as a notification, never as a failed tool call.
 */
export function writePlan(
  projectDir: string,
  plan: PlanSpec,
  fileName: string,
  status: PlanStatus,
  fs: ConfigFs,
  now: () => number,
): string {
  const path = planPath(projectDir, fileName);
  fs.mkdirSync(plansDir(projectDir));
  fs.writeFileSync(path, renderPlanMarkdown(plan, now(), status));
  return path;
}
