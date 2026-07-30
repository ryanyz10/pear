export type Finding = {
  file: string;
  line: number;
  issue: string;
  size: "small" | "medium" | "large";
  confidence: "low" | "medium" | "high";
};

const SIZES = new Set(["small", "medium", "large"]);
const CONFS = new Set(["low", "medium", "high"]);

export function parseFindings(raw: string): Finding[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("review response is not a JSON array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`malformed JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("review response is not a JSON array");
  const out: Finding[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") throw new Error("finding is not an object");
    const f = item as Record<string, unknown>;
    if (typeof f.file !== "string" || typeof f.issue !== "string") throw new Error("finding missing file/issue");
    if (typeof f.line !== "number") throw new Error("finding.line must be a number");
    if (!SIZES.has(f.size as string)) throw new Error(`invalid size: ${f.size}`);
    if (!CONFS.has(f.confidence as string)) throw new Error(`invalid confidence: ${f.confidence}`);
    out.push({
      file: f.file,
      line: f.line,
      issue: f.issue,
      size: f.size as Finding["size"],
      confidence: f.confidence as Finding["confidence"],
    });
  }
  return out;
}

/** Discard small+low; keep everything else. */
export function triage(findings: Finding[]): { kept: Finding[]; filtered: number } {
  const kept = findings.filter((f) => !(f.size === "small" && f.confidence === "low"));
  return { kept, filtered: findings.length - kept.length };
}

export function formatFindings(kept: Finding[], filtered: number): string {
  if (kept.length === 0) {
    return `── navigator ── no issues to report (${filtered} filtered)\n`;
  }
  const groups: Record<string, Finding[]> = { large: [], medium: [], small: [] };
  for (const f of kept) groups[f.size]!.push(f);
  const lines = ["── navigator ──"];
  for (const size of ["large", "medium", "small"] as const) {
    for (const f of groups[size]!) {
      lines.push(`[${f.size}/${f.confidence}] ${f.file}:${f.line} — ${f.issue}`);
    }
  }
  if (filtered) lines.push(`(${filtered} small+low filtered)`);
  return lines.join("\n") + "\n";
}

export const REVIEW_SYSTEM = `You are a code navigator reviewing a human's uncommitted changes.
Return ONLY a JSON array of findings. Each finding:
{ "file": string, "line": number, "issue": string, "size": "small"|"medium"|"large", "confidence": "low"|"medium"|"high" }
Be specific. Prefer high-confidence, real problems. Empty array [] if nothing worth raising.`;
