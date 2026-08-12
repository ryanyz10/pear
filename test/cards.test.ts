import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askCard } from "../adapters/pi/cards/ask.ts";
import { plainLines, type CardOption, type CardSpec } from "../adapters/pi/cards/card.ts";
import { checkpointCard, reviewableFiles } from "../adapters/pi/cards/checkpoint.ts";
import { planCard } from "../adapters/pi/cards/plan.ts";

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

describe("plainLines", () => {
  it("indents items and preserves blank lines", () => {
    const spec = view({ gitFiles: ["a.ts"] });
    const lines = plainLines(spec);
    assert.ok(lines.includes(""), "blank separators survive");
    assert.ok(lines.includes("  a.ts"), "items are indented");
  });
});
