/**
 * Dialog fallback for every card, driven by the same `CardSpec` as the TUI
 * renderer.
 *
 * `ctx.ui.custom` is TUI-only even though `ctx.hasUI` is true in RPC, so a
 * checkpoint in an RPC session has to be assembled from `select`/`input`. Doing
 * it generically from the spec is what stops the two presentations from drifting
 * — a new option on a card is automatically available here.
 *
 * Print and JSON modes never reach this code: agent-driver degrades to `off`
 * when no dialog-capable UI exists, rather than auto-approving.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { plainLines, type CardSpec } from "./card.ts";

/**
 * Show a card as a sequence of dialogs. Resolves to `null` when the human
 * walked away at any step.
 *
 * Every abandonment — a cancelled select, a cancelled input, an empty answer —
 * is a dismissal. It is never read as an affirmative answer, because the cheap
 * failure here would be silently continuing.
 */
export async function runCardViaDialogs<A>(
  ctx: ExtensionContext,
  spec: CardSpec<A>,
): Promise<A | null> {
  const lines = plainLines(spec).filter((l) => l !== "");
  ctx.ui.notify([spec.title, ...lines].join("\n"), "info");

  const labels = spec.options.map((o) => o.label);
  const chosen = await ctx.ui.select(spec.title, labels);
  if (chosen === undefined) return null;

  const option = spec.options[labels.indexOf(chosen)];
  if (option === undefined) return null;

  if ("answer" in option) return option.answer;

  if ("editor" in option) {
    const typed = await ctx.ui.input(option.editor.prompt);
    const text = typed?.trim() ?? "";
    if (text === "") return null;
    return option.editor.answer(text);
  }

  if (option.pick.items.length === 0) return null;
  const item = await ctx.ui.select(option.pick.prompt, option.pick.items);
  if (item === undefined) return null;
  return option.pick.answer(item);
}
