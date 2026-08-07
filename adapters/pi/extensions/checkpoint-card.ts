/**
 * The checkpoint card: what the human actually sees when the agent checks in.
 *
 * Modelled on pi's bundled `question.ts` example. Two things it does that a
 * plain picker would not:
 *
 * - It shows the agent's *claimed* file list next to the **git-derived** list,
 *   so under-reporting is visible rather than taken on trust.
 * - "Make changes" opens an inline editor; an empty submission reopens it
 *   instead of submitting, so a stray Enter cannot be read as steering.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

export type CardAnswer =
  | { kind: "continue" }
  | { kind: "steer"; text: string }
  | { kind: "stop" };

export type CardView = {
  summary: string;
  next: string;
  claimedFiles: string[];
  gitFiles: string[];
  verified: boolean;
  verifyDetail?: string;
};

const OPTIONS = [
  { key: "continue", label: "Continue", hint: "looks good, keep going" },
  { key: "steer", label: "Make changes\u2026", hint: "tell them what to do instead" },
  { key: "stop", label: "Stop", hint: "I'm taking over" },
] as const;

const MAX_FILES_SHOWN = 12;

export function renderCheckpointCard(
  tui: TUI,
  theme: Theme,
  done: (result: CardAnswer | null) => void,
  view: CardView,
): Component {
  let index = 0;
  let editing = false;
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

  editor.onSubmit = (value) => {
    const text = value.trim();
    if (text === "") {
      // Empty steering is almost certainly a mis-keyed Enter, not an
      // instruction. Stay in the editor rather than sending nothing.
      editor.setText("");
      invalidate();
      return;
    }
    done({ kind: "steer", text });
  };

  function handleInput(data: string): void {
    if (editing) {
      if (matchesKey(data, Key.escape)) {
        editing = false;
        editor.setText("");
        invalidate();
        return;
      }
      editor.handleInput(data);
      invalidate();
      return;
    }

    if (matchesKey(data, Key.up)) {
      index = Math.max(0, index - 1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      index = Math.min(OPTIONS.length - 1, index + 1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = OPTIONS[index];
      if (chosen === undefined) return;
      if (chosen.key === "steer") {
        editing = true;
        invalidate();
        return;
      }
      done(chosen.key === "stop" ? { kind: "stop" } : { kind: "continue" });
      return;
    }
    if (matchesKey(data, Key.escape)) {
      done(null);
    }
  }

  function render(width: number): string[] {
    if (cached !== undefined) return cached;

    const w = Math.max(20, width);
    const lines: string[] = [];

    const wrapped = (text: string, prefix = "") => {
      const pw = visibleWidth(prefix);
      const body = wrapTextWithAnsi(text, Math.max(1, w - pw));
      body.forEach((line, i) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${line}`));
    };

    lines.push(theme.fg("accent", "\u2500".repeat(w)));
    wrapped(theme.fg("accent", theme.bold("pear checkpoint")), " ");
    lines.push("");

    wrapped(theme.fg("text", view.summary), " ");
    lines.push("");

    // Git-derived list first: it is the one that is checkable.
    if (view.verified) {
      const shown = view.gitFiles.slice(0, MAX_FILES_SHOWN);
      wrapped(
        theme.fg("muted", `changed since last checkpoint (git, best-effort) — ${view.gitFiles.length}`),
        " ",
      );
      if (shown.length === 0) {
        wrapped(theme.fg("dim", "(none detected)"), "   ");
      } else {
        for (const f of shown) wrapped(theme.fg("text", f), "   ");
        if (view.gitFiles.length > shown.length) {
          wrapped(theme.fg("dim", `\u2026and ${view.gitFiles.length - shown.length} more`), "   ");
        }
      }
    } else {
      wrapped(
        theme.fg("warning", `file list unverified${view.verifyDetail ? ` (${view.verifyDetail})` : ""}`),
        " ",
      );
    }

    // Only worth showing separately when it disagrees with git.
    const claimed = view.claimedFiles.filter((f) => !view.verified || !view.gitFiles.includes(f));
    if (claimed.length > 0) {
      lines.push("");
      wrapped(theme.fg("muted", "also reported by the agent"), " ");
      for (const f of claimed.slice(0, MAX_FILES_SHOWN)) wrapped(theme.fg("dim", f), "   ");
    }

    lines.push("");
    wrapped(theme.fg("muted", "next: ") + theme.fg("text", view.next), " ");
    lines.push("");

    for (let i = 0; i < OPTIONS.length; i++) {
      const opt = OPTIONS[i];
      if (opt === undefined) continue;
      const selected = i === index;
      const marker = selected ? theme.fg("accent", "> ") : "  ";
      const color = selected || (editing && opt.key === "steer") ? "accent" : "text";
      wrapped(
        theme.fg(color, `${i + 1}. ${opt.label}`) + theme.fg("dim", `  ${opt.hint}`),
        marker,
      );
    }

    if (editing) {
      lines.push("");
      wrapped(theme.fg("muted", "What should they do instead?"), " ");
      for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
    }

    lines.push("");
    wrapped(
      theme.fg(
        "dim",
        editing
          ? "Enter send \u00b7 Esc back"
          : "\u2191\u2193 move \u00b7 Enter choose \u00b7 Esc dismiss (pauses changes)",
      ),
      " ",
    );
    lines.push(theme.fg("accent", "\u2500".repeat(w)));

    cached = lines;
    return lines;
  }

  return {
    render,
    invalidate: () => {
      cached = undefined;
    },
    handleInput,
  } as Component;
}

/** Fallback used where rich rendering is unavailable. */
export function plainSummary(view: CardView): Component {
  return new Text(`pear checkpoint: ${view.summary}`, 0, 0);
}
