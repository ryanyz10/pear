/**
 * Every string the model or the human reads. Kept in one host-free module so
 * porting pear to another harness is a matter of re-wiring, not re-writing the
 * behaviour.
 *
 * Control flow is never derived from these strings. The runtime acts on a
 * structured outcome chosen from a picker; the text below only *describes*
 * that outcome to the model. This is what makes it safe for the human's own
 * words to be passed through verbatim.
 */

/** Cap on steering text handed to the model, to bound a pathological paste. */
export const MAX_STEERING_CHARS = 2000;

export const CHECKPOINT_TOOL_NAME = "pear_checkpoint";

export const CHECKPOINT_TOOL_DESCRIPTION = `Pause and show the human what you just changed, then get their decision before continuing.

Call this after finishing each logical change (one coherent unit of work, which may span a few edits), and always before ending a turn in which you edited anything. The human answers: continue, make changes, or stop.

This is not optional bookkeeping — it is how your pair stays oriented. Calling it is never blocked, and calling it clears the change budget.`;

/**
 * Appended to the system prompt in agent-driver mode.
 *
 * Deliberately short: long personas get diluted. It states the role, the
 * cadence, and the three answers, and nothing else.
 */
export const AGENT_DRIVER_PERSONA = `## Pair programming: you are the driver

A human is your navigator. They are not watching every edit, so you keep them oriented by checkpointing.

- Before starting a batch of related work, say what you are going for in a sentence or two.
- After each **logical change** — one coherent unit of work, which may span several edits — call \`${CHECKPOINT_TOOL_NAME}\` with:
  - \`summary\`: what you changed and *why*, in plain language
  - \`files\`: the files you touched, so they can review
  - \`next\`: what you plan to do next
- Always checkpoint before ending a turn in which you changed anything.
- Then follow the answer you get:
  - **continue** — proceed with the next step you described
  - **steering** — the human's words are the new direction; do that instead, and do not assume your previous plan still holds
  - **stop** — make no further changes
- If a tool call is blocked because a checkpoint is overdue, call \`${CHECKPOINT_TOOL_NAME}\` and then continue. The block is not an error and nothing was executed.
- Be succinct. The checkpoint is the conversation, not a status report.`;

/** Truncate steering text, marking it so the model knows it was cut. */
export function clampSteering(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_STEERING_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_STEERING_CHARS)}\n[…truncated by pear at ${MAX_STEERING_CHARS} characters]`;
}

/** Tool results, keyed by the structured outcome the human picked. */
export const RESULT_CONTINUE =
  "NAVIGATOR: continue — proceed with the next step you described.";

export function resultSteering(text: string): string {
  return `NAVIGATOR STEERING: ${clampSteering(text)}`;
}

/**
 * Stop is enforced at runtime (the tool result sets `terminate`, and mutating
 * tools stay blocked), so this text does not ask the model to police itself.
 */
export const RESULT_STOP =
  "NAVIGATOR: stop — the human is taking over. Make no further changes.";

export const RESULT_CANCELLED =
  "NAVIGATOR: no answer — the human dismissed the checkpoint and is likely about to type. Make no further changes; wait for their message.";

export const RESULT_MODE_OFF =
  "pear: mode switched off mid-checkpoint — no checkpoint was recorded. Continue as you were.";

export const RESULT_OFF =
  "pear: not in agent-driver mode, so no checkpoint is needed. Continue as you were.";

export const RESULT_ALREADY_PENDING =
  "pear: a checkpoint is already open and awaiting the navigator. Do not call it again; wait for the answer to the first one.";

/**
 * Returned when the checkpoint could not be shown (git failure, UI failure).
 * Returned as a normal result rather than thrown, so the model reliably
 * receives actionable guidance instead of a bare host error string.
 */
export function resultCheckpointFailed(detail: string): string {
  return `pear: the checkpoint could not be shown (${detail}). Nothing was recorded. Stop making changes and tell the human what you were about to do, so they can review manually.`;
}

/** Reasons attached to blocked tool calls. */
export function blockOverdue(count: number, max: number): string {
  return (
    `pear: checkpoint overdue — ${count} of ${max} changes used since the human last looked. ` +
    `NOT EXECUTED. Call ${CHECKPOINT_TOOL_NAME} (summary, files, next) to check in, then re-issue this call.`
  );
}

export const BLOCK_STOPPED =
  `pear: the navigator asked you to stop. NOT EXECUTED. Make no further changes and end your turn; ` +
  `they will tell you when to resume.`;

/** Status-bar text. */
export function statusLine(mode: string, total: number, max: number, extra?: string): string {
  const base = mode === "agent-driver" ? `pear: driver ${total}/${max}` : `pear: ${mode}`;
  return extra === undefined ? base : `${base} · ${extra}`;
}
