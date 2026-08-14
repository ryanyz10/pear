/**
 * The shared pear card: one selectable list with a body above it, an optional
 * text editor, and an optional sub-select. It mounts inline in pi's editor slot.
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
import { parseWheel } from "./mouse.ts";
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

/**
 * The smallest body worth showing. A card with less than this is all chrome and
 * no content, but it is still answerable, which is what matters: when the inline
 * card and pi's dock exceed the terminal, rows disappear from the top. The body
 * is squeezed before the options can be pushed out of reach.
 */
export const MIN_BODY_ROWS = 3;

/** Rows kept for pi's footer and at least one row of transcript. */
export const INLINE_RESERVED_ROWS = 4;

/** Rows to assume when the terminal will not say how tall it is. */
export const FALLBACK_ROWS = 24;

/**
 * Body lines per wheel notch. Three is the near-universal convention, and
 * matching it is what makes the card feel like the rest of the terminal rather
 * than like a program with opinions about your mouse.
 */
export const WHEEL_LINES = 3;

export type BodyWindow = {
  /** The slice to render. */
  lines: string[];
  /** Lines above and below the slice; both zero when nothing is hidden. */
  above: number;
  below: number;
  /** The offset actually used, after clamping. */
  offset: number;
};

/**
 * Window a card body to the rows available for it.
 *
 * Pure on purpose: the windowing is the part worth testing, and it can be
 * tested without a terminal. The renderer supplies the measured viewport and
 * the current scroll offset and draws whatever comes back.
 *
 * Clamping happens here rather than in the input handler because the viewport
 * is only known at render time — a resize can make a previously valid offset
 * point past the end of the body.
 */
export function windowBody(lines: string[], viewport: number, offset: number): BodyWindow {
  const height = Math.max(1, Math.floor(viewport));
  if (lines.length <= height) return { lines, above: 0, below: 0, offset: 0 };
  const max = lines.length - height;
  const at = Math.min(max, Math.max(0, Math.floor(offset)));
  return {
    lines: lines.slice(at, at + height),
    above: at,
    below: lines.length - (at + height),
    offset: at,
  };
}

/**
 * The one-line "there is more" marker shown under a windowed body.
 *
 * Every working key is named, not just one. A windowed body only renders its
 * current slice, so these keys are the only way to reach the rest — and laptops
 * routinely have no PgUp/PgDn, which is exactly how this went unnoticed.
 */
export function scrollHint(window: BodyWindow): string {
  const parts: string[] = [];
  if (window.above > 0) parts.push(`↑ ${window.above} above`);
  if (window.below > 0) parts.push(`↓ ${window.below} below`);
  return `${parts.join(" · ")} · j/k scroll · ^U/^D or PgUp/PgDn page · Home/End ends`;
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
  /**
   * The cache is keyed on the viewport it was rendered for. pi's TUI answers a
   * resize with `requestRender()` alone and never calls `invalidate()`, so a
   * cache that ignored the dimensions would keep serving lines laid out for the
   * old terminal.
   */
  let cachedWidth = -1;
  let cachedRows = -1;
  let cachedTuiMode = "";
  /** First body line on screen. Clamped at render time, when the viewport is known. */
  let bodyOffset = 0;
  /** Body rows the last render had room for, so paging can move by a screenful. */
  let lastViewport = MIN_BODY_ROWS;
  /** Wrapped body lines at the last render, so End knows where the end is. */
  let lastBodyLines = 0;

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

  /**
   * How many rows the inline card may use. `render` is only told the width, but
   * the card is handed the TUI, and `Terminal` exposes `rows`. The reserve keeps
   * pi's footer and one transcript row from competing with the card. A terminal
   * that will not report its height gets the same conservative fallback.
   */
  const cardRows = (): number => {
    try {
      const rows = tui.terminal.rows;
      const measured = typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? rows : FALLBACK_ROWS;
      return Math.max(1, measured - INLINE_RESERVED_ROWS);
    } catch {
      return FALLBACK_ROWS - INLINE_RESERVED_ROWS;
    }
  };

  /**
   * Move the body window by an exact number of lines. The upper bound is left
   * to `windowBody` at render time, which is the only place the viewport is
   * known — a resize can invalidate any clamp made here.
   */
  const scrollBodyBy = (lines: number): void => {
    bodyOffset = Math.max(0, bodyOffset + lines);
    invalidate();
  };

  /** Page the body. A screenful less one line, so the reader keeps their place. */
  const scrollBody = (direction: -1 | 1): void => {
    scrollBodyBy(direction * Math.max(1, lastViewport - 1));
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
    // Fullscreen pi already asks the terminal for mouse reports. Regular mode
    // deliberately does not: its complete body lives in native scrollback.
    const wheel = tui.mode === "fullscreen" ? parseWheel(data) : undefined;
    if (wheel !== undefined) {
      scrollBodyBy(wheel === "up" ? -WHEEL_LINES : WHEEL_LINES);
      return;
    }

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

    // Fullscreen has no terminal scrollback, so its body keeps explicit keys.
    // Regular mode renders every line and leaves these keys to the terminal.
    if (tui.mode === "fullscreen") {
      if (matchesKey(data, Key.pageUp)) {
        scrollBody(-1);
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        scrollBody(1);
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        scrollBody(-1);
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        scrollBody(1);
        return;
      }
      if (matchesKey(data, "k")) {
        scrollBodyBy(-1);
        return;
      }
      if (matchesKey(data, "j")) {
        scrollBodyBy(1);
        return;
      }
      if (matchesKey(data, Key.home)) {
        bodyOffset = 0;
        invalidate();
        return;
      }
      if (matchesKey(data, Key.end)) {
        // Past the end on purpose; the render clamps to whatever fits.
        bodyOffset = lastBodyLines;
        invalidate();
        return;
      }
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
    const w = Math.max(20, width);
    const rows = cardRows();
    const tuiMode = tui.mode;
    if (
      cached !== undefined &&
      cachedWidth === w &&
      cachedRows === rows &&
      cachedTuiMode === tuiMode
    ) return cached;

    // Built as three pieces so the body can be measured against what is left
    // after the chrome, which is the whole point of knowing the height.
    const head: string[] = [];
    const bodyLines: string[] = [];
    const tail: string[] = [];

    const wrapInto = (out: string[], text: string, prefix = "") => {
      const pw = visibleWidth(prefix);
      const chunk = wrapTextWithAnsi(text, Math.max(1, w - pw));
      chunk.forEach((line, i) => out.push(`${i === 0 ? prefix : " ".repeat(pw)}${line}`));
    };
    const wrapped = (text: string, prefix = "") => wrapInto(tail, text, prefix);

    const rule = theme.fg("accent", "─".repeat(w));
    head.push(rule);
    wrapInto(head, theme.fg("accent", theme.bold(spec.title)), " ");
    head.push("");

    for (const line of spec.lines) {
      if (line.text === "") {
        bodyLines.push("");
        continue;
      }
      wrapInto(bodyLines, theme.fg(THEME_KEY[line.tone], line.text), ` ${" ".repeat(line.indent)}`);
    }

    tail.push("");

    for (let i = 0; i < spec.options.length; i++) {
      const option = spec.options[i];
      if (option === undefined) continue;
      const optionSelected = i === index && mode.at === "options";
      const active = mode.at !== "options" && mode.option === i;
      const marker = optionSelected ? theme.fg("accent", "› ") : "  ";
      const color = optionSelected || active ? "accent" : "text";
      wrapped(
        theme.fg(color, option.label) +
          (option.hint === undefined ? "" : theme.fg("dim", `  ${option.hint}`)),
        marker,
      );
    }

    if (mode.at === "editor") {
      const option = optionAt(mode.option);
      tail.push("");
      if (option !== undefined && "editor" in option) {
        wrapped(theme.fg("muted", option.editor.prompt), " ");
      }
      for (const line of editor.render(Math.max(1, w - 2))) tail.push(` ${line}`);
    }

    if (mode.at === "pick") {
      const option = optionAt(mode.option);
      const picked = mode.index;
      tail.push("");
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

    tail.push("");
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
    tail.push(rule);

    lastBodyLines = bodyLines.length;
    const out = [...head];
    if (tuiMode === "regular") {
      // The complete body becomes ordinary terminal scrollback. The options
      // stay at the live bottom of the inline component.
      bodyOffset = 0;
      lastViewport = Math.max(MIN_BODY_ROWS, bodyLines.length);
      out.push(...bodyLines);
    } else {
      // Fullscreen has a fixed viewport and clips an over-tall editor dock, so
      // keep the body inside the rows left after the card chrome.
      const budget = rows - head.length - tail.length;
      if (bodyLines.length <= budget) {
        bodyOffset = 0;
        lastViewport = Math.max(MIN_BODY_ROWS, bodyLines.length);
        out.push(...bodyLines);
      } else if (budget >= 2) {
        // One row goes to the marker, so the human can tell there is more.
        const viewport = budget - 1;
        const window = windowBody(bodyLines, viewport, bodyOffset);
        bodyOffset = window.offset;
        lastViewport = viewport;
        out.push(...window.lines);
        wrapInto(out, theme.fg("dim", scrollHint(window)), " ");
      } else {
        // A terminal too short for the chrome alone. Keep the options usable.
        bodyOffset = 0;
        lastViewport = MIN_BODY_ROWS;
      }
    }
    out.push(...tail);

    cached = out;
    cachedWidth = w;
    cachedRows = rows;
    cachedTuiMode = tuiMode;
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
