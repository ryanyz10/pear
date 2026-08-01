import {
  parseFindings,
  triage,
  REVIEW_SYSTEM,
  type Finding,
} from "./review.ts";

export type Complete = (system: string, user: string) => Promise<string>;

export async function runReview(
  complete: Complete,
  diff: string,
): Promise<{ kept: Finding[]; filtered: number }> {
  const raw = await complete(
    REVIEW_SYSTEM,
    `Review this working-tree diff:\n\n${diff || "(empty diff)"}`,
  );
  const findings = parseFindings(raw);
  return triage(findings);
}
