/**
 * The shared pear card: one selectable list with a body above it, an optional
 * inline editor, and an optional sub-select.
 *
 * All three pear tools render through this. The important structural choice is
 * that a card is **data** (`CardSpec`) rather than a component: the TUI renderer
 * below and the dialog fallback in `dialogs.ts` both consume the same spec, so
 * the two presentations cannot drift apart. It also means card content is
 * unit-testable without a terminal.
 *
 * Modelled on pi's bundled `question.ts` example.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

/** How a body line is emphasised. Mapped to theme colours at render time. */
export type Tone = "text" | "muted" | "dim" | "warn";

export type CardLine = { text: string; tone: Tone; indent: number };

/**
 * What choosing an option does.
 *
 * - plain    — answer immediately
 * - editor   — collect free text, then answer
 * - pick     — choose from a list, then answer
 *
 * Every variant ends in an answer. There is deliberately no "stay open" option:
 * a card that keeps the agent parked while the human reads is the thing this
 * design exists to avoid.
 */
export type CardOption<A> = {
  label: string;
  hint?: string;
} & (
  | { answer: A }
  | { editor: { prompt: string; answer: (text: string) => A } }
  | { pick: { prompt: string; items: string[]; answer: (item: string) => A } }
);

export type CardSpec<A> = {
  title: string;
  lines: CardLine[];
  options: CardOption<A>[];
  /** Shown after the options. Defaults to the standard key hints. */
  footer?: string;
};

/** Convenience builder for a card body. */
export function body(): {
  text: (s: string) => void;
  muted: (s: string) => void;
  dim: (s: string) => void;
  warn: (s: string) => void;
  item: (s: string, tone?: Tone) => void;
  blank: () => void;
  lines: CardLine[];
} {
  const lines: CardLine[] = [];
  const push = (text: string, tone: Tone, indent = 0) => lines.push({ text, tone, indent });
  return {
    lines,
    text: (s) => push(s, "text"),
    muted: (s) => push(s, "muted"),
    dim: (s) => push(s, "dim"),
    warn: (s) => push(s, "warn"),
    item: (s, tone = "text") => push(s, tone, 2),
    blank: () => push("", "dim"),
  };
}

/** Body lines as plain text, for dialog fallbacks and tests. */
export function plainLines<A>(spec: CardSpec<A>): string[] {
  return spec.lines.map((l) => (l.text === "" ? "" : `${" ".repeat(l.indent)}${l.text}`));
}

const THEME_KEY: Record<Tone, ThemeColor> = {
  text: "text",
  muted: "muted",
  dim: "dim",
  warn: "warning",
};

/**
 * Render a card and resolve via `done`.
 *
 * `done(null)` means dismissed — the caller maps that to its own "the human
 * stepped away" answer rather than guessing at an affirmative one.
 */
export function renderCard<A>(
  tui: TUI,
  theme: Theme,
  done: (answer: A | null) => void,
  spec: CardSpec<A>,
): Component {
  type Mode = { at: "options" } | { at: "editor"; option: number } | { at: "pick"; option: number; index: number };

  let index = 0;
  let mode: Mode = { at: "options" };
  let cached: string[] | undefined;

  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);

  const invalidate = () => {
    cached = undefined;
    tui.requestRender();
  };

  const optionAt = (i: number): CardOption<A> | undefined => spec.options[i];

  editor.onSubmit = (value) => {
    if (mode.at !== "editor") return;
    const text = value.trim();
    if (text === "") {
      // An empty submission is almost certainly a mis-keyed Enter, not an
      // instruction. Stay in the editor rather than sending nothing.
      editor.setText("");
      invalidate();
      return;
    }
    const option = optionAt(mode.option);
    if (option !== undefined && "editor" in option) done(option.editor.answer(text));
  };

  function choose(i: number): void {
    const option = optionAt(i);
    if (option === undefined) return;
    if ("editor" in option) {
      mode = { at: "editor", option: i };
      invalidate();
      return;
    }
    if ("pick" in option) {
      // Nothing to pick from means the option is inapplicable right now;
      // silently doing nothing is better than answering with a wrong item.
      if (option.pick.items.length === 0) return;
      mode = { at: "pick", option: i, index: 0 };
      invalidate();
      return;
    }
    done(option.answer);
  }

  function handleInput(data: string): void {
    if (mode.at === "editor") {
      if (matchesKey(data, Key.escape)) {
        mode = { at: "options" };
        editor.setText("");
        invalidate();
        return;
      }
      editor.handleInput(data);
      invalidate();
      return;
    }

    if (mode.at === "pick") {
      const option = optionAt(mode.option);
      if (option === undefined || !("pick" in option)) {
        mode = { at: "options" };
        invalidate();
        return;
      }
      const items = option.pick.items;
      if (matchesKey(data, Key.up)) {
        mode = { ...mode, index: Math.max(0, mode.index - 1) };
        invalidate();
        return;
      }
      if (matchesKey(data, Key.down)) {
        mode = { ...mode, index: Math.min(items.length - 1, mode.index + 1) };
        invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const item = items[mode.index];
        if (item !== undefined) done(option.pick.answer(item));
        return;
      }
      if (matchesKey(data, Key.escape)) {
        // Back to the options, not out of the card: the human is still deciding.
        mode = { at: "options" };
        invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      index = Math.max(0, index - 1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      index = Math.min(spec.options.length - 1, index + 1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      choose(index);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      done(null);
    }
  }

  function render(width: number): string[] {
    if (cached !== undefined) return cached;

    const w = Math.max(20, width);
    const out: string[] = [];

    const wrapped = (text: string, prefix = "") => {
      const pw = visibleWidth(prefix);
      const chunk = wrapTextWithAnsi(text, Math.max(1, w - pw));
      chunk.forEach((line, i) => out.push(`${i === 0 ? prefix : " ".repeat(pw)}${line}`));
    };

    const rule = theme.fg("accent", "─".repeat(w));
    out.push(rule);
    wrapped(theme.fg("accent", theme.bold(spec.title)), " ");
    out.push("");

    for (const line of spec.lines) {
      if (line.text === "") {
        out.push("");
        continue;
      }
      wrapped(theme.fg(THEME_KEY[line.tone], line.text), ` ${" ".repeat(line.indent)}`);
    }

    out.push("");

    for (let i = 0; i < spec.options.length; i++) {
      const option = spec.options[i];
      if (option === undefined) continue;
      const selected = i === index && mode.at === "options";
      const active = mode.at !== "options" && mode.option === i;
      const marker = selected ? theme.fg("accent", "› ") : "  ";
      const color = selected || active ? "accent" : "text";
      wrapped(
        theme.fg(color, option.label) +
          (option.hint === undefined ? "" : theme.fg("dim", `  ${option.hint}`)),
        marker,
      );
    }

    if (mode.at === "editor") {
      const option = optionAt(mode.option);
      out.push("");
      if (option !== undefined && "editor" in option) {
        wrapped(theme.fg("muted", option.editor.prompt), " ");
      }
      for (const line of editor.render(Math.max(1, w - 2))) out.push(` ${line}`);
    }

    if (mode.at === "pick") {
      const option = optionAt(mode.option);
      const picked = mode.index;
      out.push("");
      if (option !== undefined && "pick" in option) {
        wrapped(theme.fg("muted", option.pick.prompt), " ");
        option.pick.items.forEach((item, i) => {
          const selected = i === picked;
          wrapped(
            theme.fg(selected ? "accent" : "text", item),
            selected ? theme.fg("accent", "   › ") : "     ",
          );
        });
      }
    }

    out.push("");
    wrapped(
      theme.fg(
        "dim",
        mode.at === "editor"
          ? "Enter send · Esc back"
          : mode.at === "pick"
            ? "↑↓ move · Enter choose · Esc back"
            : (spec.footer ??
              "↑↓ move · Enter choose · Esc dismiss (pauses changes)"),
      ),
      " ",
    );
    out.push(rule);

    cached = out;
    return out;
  }

  return {
    render,
    invalidate: () => {
      cached = undefined;
    },
    handleInput,
  };
}
