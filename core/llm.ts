import { FILTER_SYSTEM, parseFindings, REVIEW_SYSTEM, type Finding } from "./review.ts";

export type Complete = (system: string, user: string) => Promise<string>;

export async function runReview(
  completeSmall: Complete,
  completeLarge: Complete,
  diff: string,
): Promise<{ kept: Finding[]; filtered: number }> {
  const raw = await completeSmall(
    REVIEW_SYSTEM,
    `Review this working-tree diff:\n\n${diff || "(empty diff)"}`,
  );
  const candidates = parseFindings(raw);
  if (candidates.length === 0) return { kept: [], filtered: 0 };
  const rawFiltered = await completeLarge(
    FILTER_SYSTEM,
    `Diff:\n\n${diff || "(empty diff)"}\n\nCandidate findings:\n${JSON.stringify(candidates)}`,
  );
  const echoed = parseFindings(rawFiltered);
  // Defensive: only accept findings the filter model actually echoed back, never a newly invented one.
  const kept = echoed.filter((e) =>
    candidates.some((c) => c.file === e.file && c.line === e.line && c.issue === e.issue),
  );
  return { kept, filtered: candidates.length - kept.length };
}
