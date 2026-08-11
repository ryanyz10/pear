/**
 * The plan card: the approval gate between scoping and building.
 *
 * Nothing can be edited until this is answered affirmatively, so the two
 * non-approving options are deliberately distinct — "change something" gives the
 * agent a direction, "keep exploring" gives it nothing except permission to look
 * harder. Collapsing them would lose the difference between a corrected plan and
 * an under-informed one.
 */

import type { PlanSpec } from "../../../core/prompts.ts";
import type { PlanAnswer } from "../runtime.ts";
import { body, type CardSpec } from "./card.ts";

export function planCard(plan: PlanSpec): CardSpec<PlanAnswer> {
  const b = body();

  b.text(plan.summary);

  if (plan.steps.length > 0) {
    b.blank();
    plan.steps.forEach((step, i) => b.item(`${i + 1}. ${step}`));
  }

  if (plan.risks !== undefined && plan.risks.length > 0) {
    b.blank();
    b.muted("watch out for");
    for (const risk of plan.risks) b.item(risk, "dim");
  }

  return {
    title: "pear · plan",
    lines: b.lines,
    options: [
      { label: "Looks good", hint: "start building", answer: { kind: "approve" } },
      {
        label: "Change something…",
        hint: "tell them what to adjust",
        editor: {
          prompt: "What should change about the plan?",
          answer: (text) => ({ kind: "revise", text }),
        },
      },
      { label: "Keep exploring", hint: "not enough to go on yet", answer: { kind: "explore" } },
    ],
    footer: "↑↓ move · Enter choose · Esc dismiss (nothing is approved)",
  };
}
