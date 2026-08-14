import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askCard } from "../adapters/pi/cards/ask.ts";
import {
  MIN_BODY_ROWS,
  body,
  plainLines,
  renderCard,
  scrollHint,
  windowBody,
  type CardOption,
  type CardSpec,
} from "../adapters/pi/cards/card.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { checkpointCard, reviewableFiles } from "../adapters/pi/cards/checkpoint.ts";
import { settingCard, settingsCard } from "../adapters/pi/cards/config.ts";
import { planCard } from "../adapters/pi/cards/plan.ts";
import { CONFIG_KEYS, DEFAULTS } from "../core/config.ts";

/**
 * Card content is pure data, so it is testable without a terminal — which is
 * the point of separating the spec from the renderer.
 */
const text = <A,>(spec: CardSpec<A>) => plainLines(spec).join("\n");
const labels = <A,>(spec: CardSpec<A>) => spec.options.map((o) => o.label);

const view = (over: Partial<Parameters<typeof checkpointCard>[0]> = {}) =>
  checkpointCard({
    summary: "Wrapped the client in a retry.",
    next: "wire it into the scheduler",
    claimedFiles: [],
    gitFiles: [],
    verified: true,
    ...over,
  });

describe("every card resolves, never parks", () => {
  const specs: CardSpec<unknown>[] = [
    view(),
    planCard({ summary: "S", steps: ["A"] }),
    askCard({ question: "Q", choices: [{ label: "A" }] }),
    settingsCard(DEFAULTS),
    settingCard("allowedReadOnlyCommands", ["ls", "cat"]),
    settingCard("mode", "agent-driver"),
    settingCard("statusIcon", false),
    settingCard("reviewBudget", 200),
  ];

  it("has no option that fails to produce an answer", () => {
    // The design rule: a card answer always resolves the tool. An option with
    // none of these three shapes would leave the agent parked.
    for (const spec of specs) {
      for (const option of spec.options as CardOption<unknown>[]) {
        const resolves = "answer" in option || "editor" in option || "pick" in option;
        assert.ok(resolves, `${spec.title} / ${option.label} must resolve`);
      }
    }
  });

  it("offers at least two options", () => {
    for (const spec of specs) assert.ok(spec.options.length >= 2, spec.title);
  });
});

describe("checkpoint card", () => {
  it("leads with the summary and ends with what comes next", () => {
    const rendered = text(view());
    assert.match(rendered, /^Wrapped the client in a retry\./);
    assert.match(rendered, /next: wire it into the scheduler/);
  });

  it("shows git's file list with a count", () => {
    const rendered = text(view({ gitFiles: ["a.ts", "b.ts"] }));
    assert.match(rendered, /changed \(2\)/);
    assert.match(rendered, /a\.ts/);
    assert.match(rendered, /b\.ts/);
  });

  it("says so plainly when git detected nothing", () => {
    assert.match(text(view()), /\(none detected\)/);
  });

  it("warns instead of implying an empty change set when git is unavailable", () => {
    const rendered = text(view({ verified: false, verifyDetail: "not a git repo" }));
    assert.match(rendered, /file list unverified \(not a git repo\)/);
    assert.doesNotMatch(rendered, /none detected/, "unverified is not the same as empty");
  });

  it("calls out a claimed file git did not corroborate", () => {
    const rendered = text(view({ gitFiles: ["a.ts"], claimedFiles: ["a.ts", "ghost.ts"] }));
    assert.match(rendered, /also reported by the agent/);
    assert.match(rendered, /ghost\.ts/);
  });

  it("does not repeat a claimed file git already confirmed", () => {
    const rendered = text(view({ gitFiles: ["a.ts"], claimedFiles: ["a.ts"] }));
    assert.doesNotMatch(rendered, /also reported by the agent/);
  });

  it("truncates a very long file list rather than flooding the card", () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    assert.match(text(view({ gitFiles: many })), /…and 18 more/);
  });

  it("offers the four answers in order", () => {
    assert.deepEqual(labels(view()), [
      "Keep going",
      "Walk me through a file…",
      "Change direction…",
      "Stop here",
    ]);
  });

  it("offers git's files for a walkthrough, plus anything only the agent named", () => {
    assert.deepEqual(
      reviewableFiles({
        summary: "",
        next: "",
        gitFiles: ["a.ts"],
        claimedFiles: ["a.ts", "b.ts"],
        verified: true,
      }),
      ["a.ts", "b.ts"],
      "deduplicated, git first",
    );
  });

  it("falls back to the agent's list when git is unavailable", () => {
    assert.deepEqual(
      reviewableFiles({
        summary: "",
        next: "",
        gitFiles: ["stale.ts"],
        claimedFiles: ["b.ts"],
        verified: false,
      }),
      ["b.ts"],
      "an unverified git list must not be offered as fact",
    );
  });

  it("says there is nothing to review when no file is known", () => {
    const option = view().options[1];
    assert.match(option?.hint ?? "", /nothing to review/);
  });
});

describe("plan card", () => {
  it("numbers the steps", () => {
    const rendered = text(planCard({ summary: "Fix it.", steps: ["First", "Second"] }));
    assert.match(rendered, /1\. First/);
    assert.match(rendered, /2\. Second/);
  });

  it("shows risks when there are any, and omits the heading otherwise", () => {
    assert.match(text(planCard({ summary: "S", steps: [], risks: ["Breaks X"] })), /watch out for/);
    assert.doesNotMatch(text(planCard({ summary: "S", steps: [] })), /watch out for/);
  });

  it("keeps revising and exploring distinct", () => {
    // One gives the agent a direction, the other only permission to look
    // harder. Collapsing them loses that difference.
    assert.deepEqual(labels(planCard({ summary: "S", steps: [] })), [
      "Looks good",
      "Change something…",
      "Keep exploring",
    ]);
  });

  it("says plainly that dismissing approves nothing", () => {
    assert.match(planCard({ summary: "S", steps: [] }).footer ?? "", /nothing is approved/);
  });

  it("shows context, decisions, and open questions as sections", () => {
    const rendered = text(
      planCard({
        summary: "S",
        context: "The client retries nothing today.",
        decisions: ["Retry on 5xx only"],
        steps: ["A"],
        openQuestions: ["Timeout value?"],
      }),
    );
    assert.match(rendered, /context/);
    assert.match(rendered, /The client retries nothing today\./);
    assert.match(rendered, /what you decided/);
    assert.match(rendered, /Retry on 5xx only/);
    assert.match(rendered, /still open/);
    assert.match(rendered, /Timeout value\?/);
  });

  it("omits sections that are not filled in", () => {
    const rendered = text(planCard({ summary: "S", steps: ["A"] }));
    for (const label of ["context", "what you decided", "still open"]) {
      assert.doesNotMatch(rendered, new RegExp(label));
    }
  });

  it("names the draft once a round has been iterated", () => {
    assert.equal(planCard({ summary: "S", steps: [] }).title, "pear · plan");
    assert.equal(planCard({ summary: "S", steps: [] }, 2).title, "pear · plan · draft 2");
  });
});

describe("ask card", () => {
  it("shows the question and the agent's options", () => {
    const spec = askCard({
      question: "Which queue?",
      choices: [{ label: "The existing one", description: "already wired up" }, { label: "A new one" }],
    });
    assert.match(text(spec), /Which queue\?/);
    assert.deepEqual(labels(spec), ["The existing one", "A new one", "Something else…"]);
    assert.equal(spec.options[0]?.hint, "already wired up");
  });

  it("always appends a free-text escape, even with no options", () => {
    // The human must never be boxed in by the agent's imagination.
    const spec = askCard({ question: "Q", choices: [] });
    assert.deepEqual(labels(spec), ["Something else…"]);
    assert.ok("editor" in (spec.options[0] as object));
  });

  it("answers with the option label the human picked", () => {
    const spec = askCard({ question: "Q", choices: [{ label: "Use a Map" }] });
    const option = spec.options[0];
    assert.ok(option !== undefined && "answer" in option);
    assert.deepEqual(option.answer, { kind: "answer", text: "Use a Map" });
  });
});

describe("settings cards", () => {
  it("keeps every picker label to one line", () => {
    // The whole point of the rewrite: pi's selector loses its indent on a
    // wrapped label, so a value never goes into one at full length.
    for (const label of labels(settingsCard(DEFAULTS))) {
      assert.ok(label.length <= 70, label);
      assert.ok(!label.includes("\n"), label);
    }
  });

  it("offers one option per setting, carrying the key back", () => {
    const spec = settingsCard(DEFAULTS);
    assert.equal(spec.options.length, CONFIG_KEYS.length);
    const first = spec.options[0];
    assert.ok(first !== undefined && "answer" in first);
    assert.deepEqual(first.answer, { key: CONFIG_KEYS[0] });
  });

  it("shows the full list in the body, where it can scroll", () => {
    const shown = text(settingCard("allowedReadOnlyCommands", DEFAULTS.allowedReadOnlyCommands));
    for (const entry of DEFAULTS.allowedReadOnlyCommands) assert.match(shown, new RegExp(entry));
    assert.match(shown, new RegExp(`${DEFAULTS.allowedReadOnlyCommands.length} commands`));
  });

  it("warns when the list has been emptied", () => {
    assert.match(text(settingCard("allowedReadOnlyCommands", [])), /empty/);
  });

  it("lets a list be added to, removed from, replaced, or reset", () => {
    assert.deepEqual(labels(settingCard("allowedReadOnlyCommands", ["ls"])), [
      "Add a command",
      "Remove a command",
      "Replace the whole list",
      "Reset to default",
    ]);
  });

  it("removes by rebuilding the list, not by echoing the entry back", () => {
    // An entry containing a comma would not survive a `-entry` round trip.
    const spec = settingCard("allowedReadOnlyCommands", ["ls", "git log, please", "cat"]);
    const remove = spec.options[1];
    assert.ok(remove !== undefined && "pick" in remove);
    assert.deepEqual(remove.pick.items, ["ls", "git log, please", "cat"]);
    assert.deepEqual(remove.pick.answer("git log, please"), {
      kind: "value",
      value: ["ls", "cat"],
    });
  });

  it("marks an added command as an addition, not a replacement", () => {
    const add = settingCard("allowedReadOnlyCommands", ["ls"]).options[0];
    assert.ok(add !== undefined && "editor" in add);
    assert.deepEqual(add.editor.answer("rg"), { kind: "add", text: "rg" });
  });

  it("offers the modes as choices rather than as free text", () => {
    assert.deepEqual(labels(settingCard("mode", "off")), [
      "off",
      "agent-driver",
      "human-driver",
      "Reset to default",
    ]);
  });

  it("offers a boolean as two choices", () => {
    assert.deepEqual(labels(settingCard("statusIcon", false)), [
      "true",
      "false",
      "Reset to default",
    ]);
  });

  it("asks for a number as text, with its bounds shown", () => {
    const spec = settingCard("reviewBudget", 200);
    const set = spec.options[0];
    assert.ok(set !== undefined && "editor" in set);
    assert.deepEqual(set.editor.answer("300"), { kind: "edit", text: "300" });
    assert.match(text(spec), /currently 200/);
    assert.match(text(spec), /whole number/);
  });

  it("resets to the shipped value, whatever the key", () => {
    for (const key of CONFIG_KEYS) {
      const options = settingCard(key, undefined).options;
      const reset = options[options.length - 1];
      assert.ok(reset !== undefined && "answer" in reset, key);
      assert.deepEqual(reset.answer, { kind: "value", value: DEFAULTS[key] }, key);
    }
  });
});

describe("plainLines", () => {
  it("indents items and preserves blank lines", () => {
    const spec = view({ gitFiles: ["a.ts"] });
    const lines = plainLines(spec);
    assert.ok(lines.includes(""), "blank separators survive");
    assert.ok(lines.includes("  a.ts"), "items are indented");
  });
});

/** `["0", "1", ... ]`, so a slice says exactly where it came from. */
const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i));

describe("windowBody", () => {
  it("leaves a body that fits alone", () => {
    const lines = numbered(4);
    const window = windowBody(lines, 10, 0);
    assert.deepEqual(window, { lines, above: 0, below: 0, offset: 0 });
  });

  it("ignores a stale offset when everything fits", () => {
    // A resize can grow the viewport past the body while an offset is still set.
    const window = windowBody(numbered(4), 10, 3);
    assert.equal(window.offset, 0);
    assert.equal(window.lines.length, 4);
  });

  it("shows the top of a long body first", () => {
    const window = windowBody(numbered(20), 5, 0);
    assert.deepEqual(window.lines, ["0", "1", "2", "3", "4"]);
    assert.equal(window.above, 0);
    assert.equal(window.below, 15);
  });

  it("counts what is hidden on both sides", () => {
    const window = windowBody(numbered(20), 5, 7);
    assert.deepEqual(window.lines, ["7", "8", "9", "10", "11"]);
    assert.equal(window.above, 7);
    assert.equal(window.below, 8);
    assert.equal(window.above + window.lines.length + window.below, 20);
  });

  it("clamps an offset past the end to the last screenful", () => {
    // Paging repeatedly must land on the bottom, never past it: the last line
    // of the body has to be reachable and has to stay reachable.
    const window = windowBody(numbered(20), 5, 999);
    assert.equal(window.offset, 15);
    assert.deepEqual(window.lines, ["15", "16", "17", "18", "19"]);
    assert.equal(window.below, 0);
  });

  it("clamps a negative offset to the top", () => {
    const window = windowBody(numbered(20), 5, -4);
    assert.equal(window.offset, 0);
    assert.equal(window.above, 0);
  });

  it("never returns an empty window", () => {
    // A terminal too short to render anything must still render something.
    const window = windowBody(numbered(20), 0, 0);
    assert.equal(window.lines.length, 1);
  });

  it("keeps every line reachable by paging", () => {
    const lines = numbered(37);
    const viewport = MIN_BODY_ROWS;
    const seen = new Set<string>();
    for (let offset = 0; offset <= lines.length; offset += Math.max(1, viewport - 1)) {
      for (const line of windowBody(lines, viewport, offset).lines) seen.add(line);
    }
    assert.equal(seen.size, lines.length, "a screenful-minus-one page reaches every line");
  });
});

describe("scrollHint", () => {
  it("names only the direction that has more", () => {
    assert.match(scrollHint(windowBody(numbered(20), 5, 0)), /15 below/);
    assert.doesNotMatch(scrollHint(windowBody(numbered(20), 5, 0)), /above/);
    assert.doesNotMatch(scrollHint(windowBody(numbered(20), 5, 15)), /below/);
  });

  it("names both when the body is windowed in the middle", () => {
    const hint = scrollHint(windowBody(numbered(20), 5, 7));
    assert.match(hint, /7 above/);
    assert.match(hint, /8 below/);
  });

  it("says which keys scroll it", () => {
    assert.match(scrollHint(windowBody(numbered(20), 5, 0)), /PgUp\/PgDn/);
  });
});

/**
 * The renderer, exercised against a stub terminal.
 *
 * Normally card *content* is asserted as data and the renderer is left alone,
 * but the height it renders to is not content — it is the one thing a data test
 * cannot see, and getting it wrong is now silent. The card is shown as an
 * overlay, and pi's compositor slices an over-tall overlay from the bottom, so
 * a card one line too tall loses its options and becomes unanswerable rather
 * than merely ugly.
 *
 * `Editor`'s constructor only stores its arguments, so a stub TUI is enough.
 */
describe("renderCard", () => {
  const stubTui = (rows: number) =>
    ({ terminal: { rows, columns: 80 }, requestRender: () => {} }) as unknown as TUI;
  // Identity styling: the assertions are about how many lines come back, and
  // real colour codes would only make a width mismatch harder to read.
  const stubTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

  const spec = (bodyRows: number): CardSpec<string> => {
    const b = body();
    for (let i = 0; i < bodyRows; i++) b.text(`body line ${i}`);
    return {
      title: "A card",
      lines: b.lines,
      options: [{ label: "keep going", answer: "continue" }, { label: "stop", answer: "stop" }],
    };
  };

  const rendered = (rows: number, bodyRows: number): string[] => {
    const card = renderCard(stubTui(rows), stubTheme, () => {}, spec(bodyRows));
    return card.render(80);
  };

  it("never renders taller than the terminal", () => {
    for (const rows of [8, 12, 24, 40, 80]) {
      // A terminal shorter than the card's own chrome cannot be satisfied by any
      // amount of squeezing, so that is the floor the invariant is measured
      // against — rendered rather than hardcoded, so it tracks the chrome.
      const chromeOnly = rendered(rows, 0).length;
      const ceiling = Math.max(rows, chromeOnly);
      for (const bodyRows of [0, 1, 5, 30, 200, 1000]) {
        const lines = rendered(rows, bodyRows);
        assert.ok(
          lines.length <= ceiling,
          `${bodyRows} body lines in ${rows} rows rendered ${lines.length}, over ${ceiling}`,
        );
      }
    }
  });

  it("fits exactly on any terminal that can hold its chrome", () => {
    // The case that matters in practice. Below this the card is unusable anyway.
    for (const rows of [12, 24, 40, 80]) {
      assert.ok(rendered(rows, 1000).length <= rows, `overflowed a ${rows}-row terminal`);
    }
  });

  it("keeps the options even when the body cannot fit", () => {
    // The failure this guards: the body growing to MIN_BODY_ROWS used to push
    // the card past the screen, and an overlay is sliced from the bottom.
    for (const rows of [8, 10, 14]) {
      const lines = rendered(rows, 500).join("\n");
      assert.match(lines, /keep going/, `options lost at ${rows} rows`);
      assert.match(lines, /stop/, `options lost at ${rows} rows`);
    }
  });

  it("shows the whole body when it fits, with no scroll marker", () => {
    const lines = rendered(40, 5).join("\n");
    assert.match(lines, /body line 4/);
    assert.doesNotMatch(lines, /below/);
  });

  it("marks a windowed body as scrollable", () => {
    const lines = rendered(24, 200).join("\n");
    assert.match(lines, /below/);
    assert.match(lines, /PgUp\/PgDn/);
  });
});

/**
 * Scroll bindings, driven as real key sequences.
 *
 * The card is a fullscreen overlay and contributes nothing to the terminal's
 * scrollback, so these keys are the only way to read past the first screenful.
 * A laptop with no PgUp/PgDn made the body unreachable entirely, which is why
 * more than one binding is asserted here.
 *
 * The sequences are the legacy forms pi's `matchesKey` accepts (keys.js:236 and
 * the CSI-with-modifier form at :438), not invented ones.
 */
describe("scrolling the card body", () => {
  const KEYS = {
    lineUp: "k",
    lineDown: "j",
    ctrlPageUp: "\x15", // ^U
    ctrlPageDown: "\x04", // ^D
    home: "\x1b[H",
    end: "\x1b[F",
    pageDown: "\x1b[6~",
    pageUp: "\x1b[5~",
    up: "\x1b[A",
    down: "\x1b[B",
  };

  const stubTui = (rows: number) =>
    ({ terminal: { rows, columns: 80 }, requestRender: () => {} }) as unknown as TUI;
  const stubTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

  /** A card whose body is far too long to fit, so it is always windowed. */
  const scrollable = () => {
    const b = body();
    for (let i = 0; i < 300; i++) b.text(`body line ${i}`);
    const card = renderCard(stubTui(24), stubTheme, () => {}, {
      title: "A long card",
      lines: b.lines,
      options: [{ label: "keep going", answer: "continue" }],
    });
    const draw = () => card.render(80).join("\n");
    draw(); // first render establishes the viewport the bindings move by
    // `handleInput` is optional on pi's Component, so bind a non-optional one.
    const press = (data: string) => card.handleInput?.(data);
    return { press, draw };
  };

  it("scrolls a line at a time with j and k", () => {
    const { press, draw } = scrollable();
    assert.match(draw(), /body line 0/);

    press(KEYS.lineDown);
    assert.doesNotMatch(draw(), /body line 0\b/);
    assert.match(draw(), /body line 1/);

    press(KEYS.lineUp);
    assert.match(draw(), /body line 0/);
  });

  it("jumps to the ends with Home and End", () => {
    const { press, draw } = scrollable();
    press(KEYS.end);
    const atEnd = draw();
    assert.match(atEnd, /body line 299/);
    assert.doesNotMatch(atEnd, /below/, "nothing left below at the end");

    press(KEYS.home);
    const atTop = draw();
    assert.match(atTop, /body line 0/);
    assert.doesNotMatch(atTop, /above/, "nothing above at the top");
  });

  it("pages with PgUp/PgDn", () => {
    const { press, draw } = scrollable();
    press(KEYS.pageDown);
    // A page is a screenful less one line of overlap, so it moves much further
    // than the single line j does.
    assert.doesNotMatch(draw(), /body line 1\b/);

    press(KEYS.pageUp);
    assert.match(draw(), /body line 0/);
  });

  it("pages with ^U and ^D, for a keyboard with no PgUp/PgDn", () => {
    // The case that started this: the navigator's laptop has no PgUp/PgDn, so
    // an alias that survives on any keyboard is the point, not a convenience.
    const { press, draw } = scrollable();
    press(KEYS.ctrlPageDown);
    assert.doesNotMatch(draw(), /body line 1\b/);

    press(KEYS.ctrlPageUp);
    assert.match(draw(), /body line 0/);
  });

  it("clamps at both ends rather than running off", () => {
    const { press, draw } = scrollable();
    for (let i = 0; i < 5; i++) press(KEYS.lineUp);
    assert.match(draw(), /body line 0/, "cannot scroll above the start");

    press(KEYS.end);
    for (let i = 0; i < 5; i++) press(KEYS.lineDown);
    assert.match(draw(), /body line 299/, "cannot scroll past the end");
  });

  it("leaves plain arrows to the options", () => {
    // The whole reason the line step is j/k and not the arrows.
    const { press, draw } = scrollable();
    press(KEYS.down);
    assert.match(draw(), /body line 0/, "plain ↓ must not scroll the body");
  });

  it("names every working key, so none of them is undiscoverable", () => {
    const { draw } = scrollable();
    const hint = draw();
    assert.match(hint, /j\/k/);
    assert.match(hint, /\^U\/\^D/);
    assert.match(hint, /PgUp\/PgDn/);
    assert.match(hint, /Home\/End/);
  });
});
