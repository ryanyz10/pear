/**
 * The plan card: the approval gate between scoping and building.
 *
 * Nothing can be edited until this is answered affirmatively, so the two
 * non-approving options are deliberately distinct — "change something" gives the
 * agent a direction, "keep exploring" gives it nothing except permission to look
 * harder. Collapsing them would lose the difference between a corrected plan and
 * an under-informed one.
 *
 * The card mirrors `formatPlan`'s sections (summary, context, decisions, steps,
 * open questions, risks) and shows which draft of the scoping round this is, so
 * iterating is visible progress rather than a form being re-filed.
 */

import type { PlanSpec } from "../../../core/prompts.ts";
import type { PlanAnswer } from "../runtime.ts";
import { body, type CardSpec } from "./card.ts";

export function planCard(plan: PlanSpec, draft = 0): CardSpec<PlanAnswer> {
  const b = body();

  b.text(plan.summary);

  if (plan.context !== undefined && plan.context.trim() !== "") {
    b.blank();
    b.muted("context");
    b.item(plan.context.trim());
  }

  if (plan.decisions !== undefined && plan.decisions.length > 0) {
    b.blank();
    b.muted("what you decided");
    for (const decision of plan.decisions) b.item(decision.trim());
  }

  if (plan.steps.length > 0) {
    b.blank();
    b.muted("how we'll build it");
    plan.steps.forEach((step, i) => b.item(`${i + 1}. ${step.trim()}`));
  }

  if (plan.openQuestions !== undefined && plan.openQuestions.length > 0) {
    b.blank();
    b.muted("still open");
    for (const question of plan.openQuestions) b.item(question.trim(), "warn");
  }

  if (plan.risks !== undefined && plan.risks.length > 0) {
    b.blank();
    b.muted("watch out for");
    for (const risk of plan.risks) b.item(risk.trim(), "dim");
  }

  return {
    title: draft > 1 ? `pear · plan · draft ${draft}` : "pear · plan",
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
