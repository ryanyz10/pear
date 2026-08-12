/**
 * Persisting the plan document to `.pear/plans/`.
 *
 * The plan is pear's own artifact — written by the extension, not by the
 * agent, whose tools stay read-only through scoping. Two files:
 *
 * - `latest.md` — every proposal, draft or approved, overwritten each time a
 *   plan card is shown. This is "what are we planning right now".
 * - `approved-<timestamp>.md` — a snapshot written only when the human
 *   approves, so an approved plan survives later re-scoping drafts.
 *
 * Everything goes through an injectable fs seam, mirroring `core/config.ts`, so
 * the failure paths are testable without touching a real disk. Writes are plain
 * (not temp-file + rename) on purpose: a torn plan file is a regenerable
 * artifact, unlike config, so the atomicity machinery would protect nothing.
 */

import { join } from "node:path";
import type { ConfigFs } from "./config.ts";
import { formatPlan, type PlanSpec } from "./prompts.ts";

export function plansDir(projectDir: string): string {
  return join(projectDir, ".pear", "plans");
}

/** The live document: every proposal, draft or approved. */
export function latestPlanPath(projectDir: string): string {
  return join(plansDir(projectDir), "latest.md");
}

/** A timestamped snapshot, written only on approval. */
export function approvedPlanPath(projectDir: string, now: () => number): string {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  return join(plansDir(projectDir), `approved-${stamp}.md`);
}

/**
 * The saved file. `formatPlan` is the single renderer for card, persona, and
 * disk, so the approved document cannot drift from what the model is reminded
 * of. The header carries the write time so `latest.md` says when it was made.
 */
export function renderPlanMarkdown(plan: PlanSpec, now: () => number): string {
  const stamp = new Date(now()).toISOString();
  return `# pear plan · ${stamp}\n\n${formatPlan(plan)}\n`;
}

/**
 * Persist a proposal (draft or approved) to `latest.md`.
 *
 * @throws when the directory or file cannot be written — the caller surfaces
 *   the failure as a notification, never as a failed tool call.
 */
export function writePlanDraft(
  projectDir: string,
  plan: PlanSpec,
  fs: ConfigFs,
  now: () => number,
): void {
  const dir = plansDir(projectDir);
  fs.mkdirSync(dir);
  fs.writeFileSync(latestPlanPath(projectDir), renderPlanMarkdown(plan, now));
}

/**
 * Persist an approval: `latest.md` plus a timestamped snapshot for reference.
 *
 * @throws when either write fails; the caller decides how to surface it.
 */
export function writePlanApproved(
  projectDir: string,
  plan: PlanSpec,
  fs: ConfigFs,
  now: () => number,
): void {
  const dir = plansDir(projectDir);
  fs.mkdirSync(dir);
  fs.writeFileSync(latestPlanPath(projectDir), renderPlanMarkdown(plan, now));
  fs.writeFileSync(approvedPlanPath(projectDir, now), renderPlanMarkdown(plan, now));
}
