/**
 * The question card: pre-filled structured answers, plus an escape into free
 * text.
 *
 * The pre-filled options are the point — they are what makes answering a
 * keypress instead of a sentence. "Something else…" is always appended so the
 * human is never boxed in by the agent's imagination.
 */

import type { AskAnswer } from "../runtime.ts";
import { body, type CardOption, type CardSpec } from "./card.ts";

export type AskChoice = {
  label: string;
  description?: string;
};

export type AskView = {
  question: string;
  choices: AskChoice[];
};

export function askCard(view: AskView): CardSpec<AskAnswer> {
  const b = body();
  b.text(view.question);

  const options: CardOption<AskAnswer>[] = view.choices.map((choice) => {
    const option: CardOption<AskAnswer> = {
      label: choice.label,
      answer: { kind: "answer", text: choice.label },
    };
    return choice.description === undefined ? option : { ...option, hint: choice.description };
  });

  options.push({
    label: "Something else…",
    hint: "answer in your own words",
    editor: {
      prompt: "Your answer:",
      answer: (text) => ({ kind: "answer", text }),
    },
  });

  return {
    title: "pear · question",
    lines: b.lines,
    options,
    footer: "↑↓ move · Enter choose · Esc skip (ends the turn)",
  };
}
