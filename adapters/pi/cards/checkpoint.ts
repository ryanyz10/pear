/**
 * The checkpoint card: what the human sees when the agent checks in.
 *
 * Two things it does that a plain picker would not:
 *
 * - It shows the **git-derived** file list first and the agent's *claimed* list
 *   only where git did not corroborate it, so under-reporting is visible rather
 *   than taken on trust.
 * - "Walk me through a file" resolves the tool with an instruction rather than
 *   holding it open, which is what lets the agent talk and the card come back.
 */

import type { CheckpointAnswer } from "../runtime.ts";
import { body, type CardSpec } from "./card.ts";

export type CheckpointView = {
  summary: string;
  next: string;
  claimedFiles: string[];
  gitFiles: string[];
  verified: boolean;
  verifyDetail?: string;
};

const MAX_FILES_SHOWN = 12;

/** Files offered for a walkthrough: git's list, falling back to the agent's. */
export function reviewableFiles(view: CheckpointView): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...(view.verified ? view.gitFiles : []), ...view.claimedFiles]) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out.slice(0, MAX_FILES_SHOWN);
}

export function checkpointCard(view: CheckpointView): CardSpec<CheckpointAnswer> {
  const b = body();

  b.text(view.summary);
  b.blank();

  // Git-derived list first: it is the one that is checkable.
  if (view.verified) {
    b.muted(`changed (${view.gitFiles.length})`);
    const shown = view.gitFiles.slice(0, MAX_FILES_SHOWN);
    if (shown.length === 0) {
      b.item("(none detected)", "dim");
    } else {
      for (const f of shown) b.item(f);
      if (view.gitFiles.length > shown.length) {
        b.item(`…and ${view.gitFiles.length - shown.length} more`, "dim");
      }
    }
  } else {
    b.warn(`file list unverified${view.verifyDetail === undefined ? "" : ` (${view.verifyDetail})`}`);
  }

  // Only worth showing separately when it disagrees with git.
  const unconfirmed = view.claimedFiles.filter(
    (f) => !view.verified || !view.gitFiles.includes(f),
  );
  if (unconfirmed.length > 0) {
    b.blank();
    b.muted("also reported by the agent");
    for (const f of unconfirmed.slice(0, MAX_FILES_SHOWN)) b.item(f, "dim");
  }

  b.blank();
  b.muted(`next: ${view.next}`);

  const files = reviewableFiles(view);

  return {
    title: "pear · checkpoint",
    lines: b.lines,
    options: [
      { label: "Keep going", hint: "looks good", answer: { kind: "continue" } },
      {
        label: "Walk me through a file…",
        hint: files.length === 0 ? "nothing to review" : "explain one of these",
        pick: {
          prompt: "Which file?",
          items: files,
          answer: (file) => ({ kind: "explain", file }),
        },
      },
      {
        label: "Change direction…",
        hint: "do something else instead",
        editor: {
          prompt: "What should they do instead?",
          answer: (text) => ({ kind: "steer", text }),
        },
      },
      { label: "Stop here", hint: "I'm taking over", answer: { kind: "stop" } },
    ],
  };
}
