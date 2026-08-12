/**
 * Every string the model or the human reads. Kept in one host-free module so
 * porting pear to another harness is a matter of re-wiring, not re-writing the
 * behaviour.
 *
 * Control flow is never derived from these strings. The runtime acts on a
 * structured outcome chosen from a picker; the text below only *describes* that
 * outcome to the model. This is what makes it safe for the human's own words to
 * be passed through verbatim.
 */

/** Cap on free text handed to the model, to bound a pathological paste. */
export const MAX_STEERING_CHARS = 2000;

export const ASK_TOOL_NAME = "pear_ask";
export const PLAN_TOOL_NAME = "pear_plan";
export const CHECKPOINT_TOOL_NAME = "pear_checkpoint";

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

export const ASK_TOOL_DESCRIPTION = `Ask your navigator a question and get an answer back.

Give 2-4 concrete options you would actually be happy to act on — the point is to save them from typing, so a good option set is most of the work. They can always answer in their own words instead.

Use this whenever a decision is genuinely theirs to make: an ambiguous requirement, a tradeoff with no obvious winner, a missing piece of context only they have. Do not use it for things you can find out by reading the code.`;

export const PLAN_TOOL_DESCRIPTION = `Propose how you intend to solve the problem, and get the navigator's approval before you start building.

Write the plan as a step-by-step guide you could follow without thinking: a one-line goal (summary), what you learned while exploring (context), the decisions the navigator made (decisions), the numbered steps, anything still open (openQuestions), and risks. A step is one bounded action the navigator can recognise happening.

Nothing can be edited until a plan is approved. A first proposal is a draft — expect the navigator to send it back. Once it is approved, the plan becomes the shared frame for the rest of the session — every later checkpoint is reported against it.`;

export const CHECKPOINT_TOOL_DESCRIPTION = `Show the navigator what you just changed, then get their decision before continuing.

Call this when you reach a coherent stopping point — one recognisable piece of the plan is done, whether that took one edit or several. Always call it before ending a turn in which you changed anything.

Pass:
- \`summary\`: what you changed and *why*, in plain language, in terms of the plan
- \`files\`: the files you touched, so they can review
- \`next\`: what you intend to do next

They answer: keep going, walk me through a file, change direction, or stop. Calling this is never blocked, and it clears the review budget.`;

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

/**
 * Shared voice rules.
 *
 * The failure mode being designed against is the agent filing status reports:
 * headed sections, bulleted change lists, and narration of its own tooling.
 * A real pair says a sentence or two and keeps working.
 */
const VOICE = `## How to talk

- Plain, conversational sentences. No headers, no bullet lists, no bold labels.
- Short. One to three sentences is usually right.
- Say *why*, not just what. The what is visible in the diff; the why is not.
- Do not list the files you touched in prose — the card already shows them.
- Never narrate your own tooling ("I will now call the checkpoint tool"). Just call it.`;

/**
 * Appended to the system prompt during the scoping phase.
 *
 * This is the behavioural core of plan mode: the agent is not asked to file a
 * proposal, it is asked to run a discovery loop. A first proposal is a draft;
 * the human's revise/explore answers are the mechanism that converges it.
 */
export const SCOPING_PERSONA = `## Pair programming: discover before you build

A human is your navigator. You cannot edit anything yet. Your job is to turn the request into a plan worth approving — that takes more than one pass.

1. **Understand.** Read, search, run read-only commands. Find out what the problem actually is before you propose anything.
2. **Ask.** Use \`${ASK_TOOL_NAME}\` for anything that changes the approach: what done looks like, scope, constraints, what they already tried. Ask before you draft, not after.
3. **Draft.** Propose the plan with \`${PLAN_TOOL_NAME}\`: a one-line goal, what you learned while exploring, the decisions they made, the numbered step-by-step guide, anything still open, and risks.
4. **Iterate.** The first proposal is a draft. They will send it back — "change something" or "keep exploring" — and each round should tighten the plan. Fold what they say into the plan's decisions and open questions.

A step is only a step if it is one bounded action the navigator can recognise happening. If you could not follow your own plan without thinking, it is not ready yet. A plan with open questions is a draft that names what is missing — ask, then re-propose.

${VOICE}`;

/**
 * What the agent proposed and the human approved.
 *
 * The plan is a document, not a form: it carries the goal, what was learned
 * while scoping, the decisions the human made, the step-by-step build guide,
 * and what is still unresolved. A plan with open questions is a draft that
 * names its own gaps rather than hiding them.
 */
export type PlanSpec = {
  /** One-line goal: what done looks like. */
  summary: string;
  /** What we learned while scoping — the problem, constraints, context. */
  context?: string;
  /** The numbered build guide. One bounded action per step. */
  steps: string[];
  /** What the human explicitly decided during scoping (ask answers, steering). */
  decisions?: string[];
  /** Still unresolved. Shown on the card and to the agent. */
  openQuestions?: string[];
  /** Anything that might go wrong or need a decision. */
  risks?: string[];
};

/**
 * Render a plan for the model, for `/pear-plan`, and for the saved markdown.
 *
 * One rendering for all audiences on purpose: what the human approved, what
 * the agent is reminded of, and what is written to `.pear/plans/` must not be
 * able to drift apart. It reads as plain text in the card and as light
 * markdown in the file, so no second renderer is needed.
 */
export function formatPlan(plan: PlanSpec): string {
  const lines = [plan.summary.trim()];
  if (plan.context !== undefined && plan.context.trim() !== "") {
    lines.push("", "Context:", plan.context.trim());
  }
  if (plan.decisions !== undefined && plan.decisions.length > 0) {
    lines.push("", "What you decided:");
    for (const decision of plan.decisions) lines.push(`- ${decision.trim()}`);
  }
  if (plan.steps.length > 0) {
    lines.push("", "How we'll build it:");
    plan.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.trim()}`));
  }
  if (plan.openQuestions !== undefined && plan.openQuestions.length > 0) {
    lines.push("", "Still open:");
    for (const question of plan.openQuestions) lines.push(`- ${question.trim()}`);
  }
  if (plan.risks !== undefined && plan.risks.length > 0) {
    lines.push("", "Watch out for:");
    for (const risk of plan.risks) lines.push(`- ${risk.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Appended to the system prompt during the building phase.
 *
 * Carries the approved plan verbatim: this is what makes later checkpoint
 * summaries land against a frame the human already agreed to, rather than
 * floating free.
 */
export function buildPersona(planText: string, openQuestions?: string[]): string {
  const unsettled =
    openQuestions !== undefined && openQuestions.length > 0
      ? `- The plan above names open questions — raise them at your first checkpoint rather than guessing.\n`
      : "";
  return `## Pair programming: you are the driver

A human is your navigator. They are not watching every edit, so you keep them oriented by checkpointing.

This is the plan you both agreed to:

${planText}

${unsettled}- Say what you are going for in a sentence before starting a chunk of work.
- When one recognisable piece of the plan is done, call \`${CHECKPOINT_TOOL_NAME}\`. That may be one edit or several — stop at a coherent boundary, not mid-thought.
- Always checkpoint before ending a turn in which you changed anything.
- Then do what the answer says:
  - **keep going** — carry on with the next step you described
  - **walk me through a file** — explain that file, make no edits, then checkpoint again
  - **change direction** — their words replace your plan for what comes next; do not assume the rest of your intended sequence still holds
  - **stop** — make no further changes
- If a call is blocked because the review budget is spent, that is not an error and nothing was executed. Checkpoint, then re-issue the call.
- If the work turns out to need a different approach than the plan above, say so and call \`${PLAN_TOOL_NAME}\` rather than quietly diverging.

${VOICE}`;
}

/**
 * Appended to the system prompt when the human is driving.
 *
 * The agent is the navigator here, and the inversion needs saying plainly: it
 * reviews rather than builds, and it cannot edit at all. Carries the plan for
 * the same reason the build persona does — it is the frame the human's
 * explanation gets judged against.
 */
export function humanDriverPersona(planText: string): string {
  return `## Pair programming: you are the navigator

The human is driving. They write the code; you keep them honest about it. You cannot edit anything — if a change needs making, say so and let them make it, or suggest they run \`/pear-swap\`.

This is the plan you both agreed to:

${planText}

When they explain what they changed, you will be given the diff alongside their words. Read both, then:

- Say whether what they built matches what they just described. A mismatch between the two is the single most useful thing you can find.
- Point out logic problems, missed cases, and anything the plan called for that is not there.
- If it looks right, say so briefly and let them get back to work. Do not manufacture concerns.
- Ask about anything in the diff you genuinely do not understand — that is often where the bug is.

Judge the code, not the person. One or two real points beat a list of nitpicks.

${VOICE}`;
}

/** Truncate free text from the human, marking it so the model knows it was cut. */
export function clampSteering(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_STEERING_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_STEERING_CHARS)}\n[…truncated by pear at ${MAX_STEERING_CHARS} characters]`;
}

// ---------------------------------------------------------------------------
// Checkpoint results, keyed by the structured outcome the human picked
// ---------------------------------------------------------------------------

export const RESULT_CONTINUE =
  "NAVIGATOR: keep going — proceed with the next step you described.";

/**
 * The "dive deeper" result. It has to be explicit that this is not a
 * checkpoint answer but a detour, because the agent must come back and ask
 * again rather than treating the explanation as permission to continue.
 */
export function resultExplain(file: string): string {
  return (
    `NAVIGATOR: walk me through \`${file}\` — explain what you changed there and why, in terms of the plan. ` +
    `Make no edits. Then call ${CHECKPOINT_TOOL_NAME} again with the same summary so they can answer properly.`
  );
}

export function resultSteering(text: string): string {
  return `NAVIGATOR STEERING: ${clampSteering(text)}`;
}

/**
 * Stop is enforced at runtime (the tool result sets `terminate`, and mutating
 * tools stay blocked), so this text does not ask the model to police itself.
 */
export const RESULT_STOP =
  "NAVIGATOR: stop — the human is taking over. Make no further changes and end your turn.";

export const RESULT_DISMISSED =
  "NAVIGATOR: no answer — they stepped away from the checkpoint and are likely about to type. Make no further changes and end your turn; wait for their message.";

export const RESULT_MODE_OFF =
  "pear: mode switched off mid-checkpoint — no checkpoint was recorded. Continue as you were.";

export const RESULT_OFF =
  "pear: not in agent-driver mode, so no checkpoint is needed. Continue as you were.";

export const RESULT_ALREADY_PENDING =
  "pear: a checkpoint is already open and awaiting the navigator. Do not call it again; wait for the answer to the first one.";

/**
 * Returned when a card could not be shown (git failure, UI failure). Returned
 * as a normal result rather than thrown, so the model reliably receives
 * actionable guidance instead of a bare host error string.
 */
export function resultCheckpointFailed(detail: string): string {
  return `pear: the checkpoint could not be shown (${detail}). Nothing was recorded. Stop making changes and tell the human what you were about to do, so they can review manually.`;
}

// ---------------------------------------------------------------------------
// Plan results
// ---------------------------------------------------------------------------

/**
 * `before_agent_start` fires per run, so the run in which the plan is approved
 * is still carrying the scoping persona ("you cannot edit anything yet") in its
 * system prompt. This result has to explicitly supersede it, or the model is
 * reading two contradictory instructions at the exact moment it should start.
 */
export const RESULT_PLAN_APPROVED =
  "NAVIGATOR: plan approved — the scoping instructions no longer apply and editing is open. " +
  "Start on the first step now, and checkpoint when it is done.";

export function resultPlanRevise(text: string): string {
  return `NAVIGATOR wants the plan changed: ${clampSteering(text)}\n\nRevise it and call ${PLAN_TOOL_NAME} again. Do not start building.`;
}

export const RESULT_PLAN_KEEP_EXPLORING =
  `NAVIGATOR: not yet — keep looking into it before proposing again. Do not start building; call ${PLAN_TOOL_NAME} when you have a better proposal.`;

export const RESULT_PLAN_DISMISSED =
  "NAVIGATOR: no answer — they stepped away from the plan. End your turn and wait for their message. Do not start building.";

// ---------------------------------------------------------------------------
// Ask results
// ---------------------------------------------------------------------------

export function resultAnswer(text: string): string {
  return `NAVIGATOR: ${clampSteering(text)}`;
}

export const RESULT_ASK_DISMISSED =
  "NAVIGATOR: no answer — they stepped away from the question. End your turn and wait for their message rather than guessing.";

// ---------------------------------------------------------------------------
// Out-of-phase results
//
// pi has no way to unregister a tool, so all three exist in every phase. An
// out-of-phase call is a mistake, not an error: say what to do instead and let
// the model recover, rather than throwing.
// ---------------------------------------------------------------------------

export const RESULT_PLAN_ALREADY_APPROVED =
  `pear: a plan is already approved and you are building against it. If the approach genuinely needs to change, explain why and call ${PLAN_TOOL_NAME} again — otherwise use ${CHECKPOINT_TOOL_NAME}.`;

export const RESULT_CHECKPOINT_NO_PLAN =
  `pear: no plan is approved yet, so there is nothing to check in against. Propose one with ${PLAN_TOOL_NAME} first.`;

// ---------------------------------------------------------------------------
// Blocked tool calls
// ---------------------------------------------------------------------------

export function blockOverBudget(points: number, budget: number): string {
  return (
    `pear: checkpoint overdue — ${points} of ${budget} review points used since the human last looked. ` +
    `NOT EXECUTED. Call ${CHECKPOINT_TOOL_NAME} (summary, files, next) to check in, then re-issue this call.`
  );
}

export const BLOCK_STOPPED =
  `pear: the navigator asked you to stop. NOT EXECUTED. Make no further changes and end your turn; ` +
  `they will tell you when to resume.`;

export const BLOCK_PAUSED =
  `pear: the navigator stepped away from a checkpoint. NOT EXECUTED. End your turn and wait for them.`;

export function blockExplaining(file: string): string {
  return (
    `pear: the navigator is reviewing \`${file}\`. NOT EXECUTED. Explain the file, then call ` +
    `${CHECKPOINT_TOOL_NAME} again — no edits until they answer.`
  );
}

export const BLOCK_SCOPING =
  `pear: no plan is approved yet, so nothing can be changed. NOT EXECUTED. Finish understanding the problem and call ${PLAN_TOOL_NAME}.`;

// ---------------------------------------------------------------------------
// In-band budget nags
//
// Appended to mutating tool results. Cheap (no turn of its own) and impossible
// to miss (attached to the thing the model just did). This is the tier that v2
// lacked entirely: it went from silence straight to a hard block.
// ---------------------------------------------------------------------------

export function nagSoft(points: number, budget: number): string {
  return `pear: ${points}/${budget} review points used — look for a good place to check in.`;
}

export function nagDue(points: number, budget: number): string {
  return `pear: ${points}/${budget} review points used. Call ${CHECKPOINT_TOOL_NAME} before the next edit.`;
}

// ---------------------------------------------------------------------------
// Human-driver: the quiz loop
// ---------------------------------------------------------------------------

/** Cap on a diff handed to the model, to bound a pathological working tree. */
export const MAX_DIFF_BYTES = 200_000;

const MAX_PATHS_IN_PROMPT = 8;

/**
 * The message pear injects to start a review turn.
 *
 * It renders as an ordinary user message — `sendUserMessage` is the only way to
 * start a turn that still fires `before_agent_start`, and therefore the only
 * way the persona above gets injected. So it is labelled as pear speaking
 * rather than pretending the human typed it.
 */
export function quizPrompt(files: string[], insertions: number, deletions: number): string {
  const shown = files.slice(0, MAX_PATHS_IN_PROMPT);
  const rest = files.length - shown.length;
  const list =
    shown.length === 0
      ? "some files"
      : shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
  return (
    `(pear) I have ${files.length} uncommitted file${files.length === 1 ? "" : "s"} — ` +
    `${list} (+${insertions}/−${deletions}). Ask me to walk you through what I did and why.`
  );
}

/**
 * Widget content for the passive nudge. Kept to two lines.
 *
 * The counts describe the whole uncommitted tree, because that is exactly what
 * the agent gets handed when the conversation starts. The *pacing* discounts
 * work already reviewed (see `core/watch.ts`); the numbers on screen do not,
 * because claiming "since we last talked" while showing a whole-tree count
 * would be the one thing worse than showing a bigger number.
 */
export function nudgeLines(
  files: number,
  lines: number,
  due: boolean,
  icon = false,
): string[] {
  const scale = `${files} file${files === 1 ? "" : "s"}, ~${lines} line${lines === 1 ? "" : "s"}`;
  return [
    `${pearName(icon)} · ${scale} uncommitted`,
    due ? "worth talking through — /pear-explain" : "ready when you are",
  ];
}

/**
 * Wrap the human's explanation with the diff it is about.
 *
 * Delivered through the `input` hook's `transform`, so the agent gets the words
 * and the code in one turn and can compare them. The diff is the whole
 * uncommitted tree: a partial one would make the agent judge an explanation
 * against code it cannot see all of, which is worse than showing it twice.
 */
export function withDiff(explanation: string, diff: string): string {
  const trimmed =
    diff.length <= MAX_DIFF_BYTES
      ? diff
      : `${diff.slice(0, MAX_DIFF_BYTES)}\n[…truncated by pear at ${MAX_DIFF_BYTES} bytes]`;
  return (
    `${explanation}\n\n` +
    `<pear-diff description="What actually changed since the last review. Compare it against what I just told you.">\n` +
    `${trimmed}\n` +
    `</pear-diff>`
  );
}

export function parkedNotice(detail: string): string {
  return (
    `pear: stopped watching for changes after repeated git errors (${detail}). ` +
    `Nothing else is affected — use /pear-explain to review by hand, or /pear-swap to restart watching.`
  );
}

export const NOTHING_TO_EXPLAIN =
  "pear: nothing has changed since your last review, so there is nothing to walk through.";

/** Blocked tool calls specific to human-driver. */
export const BLOCK_HUMAN_DRIVER =
  `pear: the human is driving, so you cannot change anything. NOT EXECUTED. ` +
  `Say what you would change and let them do it, or suggest they run /pear-swap.`;

export const RESULT_CHECKPOINT_NOT_DRIVING =
  `pear: you are navigating, not driving — there is nothing for you to check in about. ` +
  `Wait for the human to explain their changes.`;

// ---------------------------------------------------------------------------
// Human-facing status
// ---------------------------------------------------------------------------

/**
 * What pear calls itself on screen.
 *
 * The icon carries no information the word doesn't, so it is opt-in and
 * cosmetic — but it costs two columns instead of five in a status bar that has
 * to share space with everything else pi puts there. Only display strings use
 * it: notifications, block reasons and prompts keep saying "pear", so what the
 * model reads and what a bug report greps for stay stable.
 */
export function pearName(icon: boolean): string {
  return icon ? "🍐" : "pear";
}

/** Status-bar text. */
export function statusLine(
  mode: string,
  phase: string,
  points: number,
  budget: number,
  extra?: string,
  icon = false,
): string {
  // The colon reads as punctuation after a word and as clutter after a glyph.
  const name = icon ? pearName(true) : "pear:";
  let base: string;
  if (mode === "off") {
    base = `${name} off`;
  } else if (phase === "scoping") {
    // Both drivers scope the same way, so the driver is not worth showing yet.
    base = `${name} scoping`;
  } else {
    const role = mode === "human-driver" ? "watching" : "driver";
    base = `${name} ${role} ${points}/${budget}`;
  }
  return extra === undefined ? base : `${base} · ${extra}`;
}
