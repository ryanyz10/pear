import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countLines,
  estimateChange,
  FILE_POINTS,
  OPAQUE_POINTS,
  pointsFor,
  pointsForWorkingTree,
} from "../core/load.ts";

/** Convenience: price a single call as if every path in it were new. */
function price(toolName: string, input: unknown): number | undefined {
  const cost = estimateChange(toolName, input);
  if (cost === undefined) return undefined;
  return pointsFor(cost, cost.paths.length);
}

function edit(path: string, hunks: { oldText: string; newText: string }[]): unknown {
  return { path, edits: hunks };
}

describe("countLines", () => {
  const cases: [string, number][] = [
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["\n", 1],
    ["\n\n", 2],
    ["a\n\nb", 3],
  ];
  for (const [text, want] of cases) {
    it(`${JSON.stringify(text)} -> ${want}`, () => {
      assert.equal(countLines(text), want);
    });
  }
});

describe("estimateChange: non-mutating tools are not priced", () => {
  for (const name of ["read", "grep", "find", "ls", "pear_checkpoint", "pear_ask", "pear_plan"]) {
    it(name, () => {
      assert.equal(estimateChange(name, { path: "a.ts" }), undefined);
    });
  }

  it("a read-only bash command", () => {
    assert.equal(estimateChange("bash", { command: "git status" }), undefined);
  });
});

describe("estimateChange: edit", () => {
  it("charges both sides of every hunk, because a diff shows both", () => {
    const cost = estimateChange("edit", edit("a.ts", [{ oldText: "x\ny", newText: "1\n2\n3" }]));
    assert.deepEqual(cost, { paths: ["a.ts"], lines: 5, opaque: false });
  });

  it("sums across hunks", () => {
    const cost = estimateChange(
      "edit",
      edit("a.ts", [
        { oldText: "x", newText: "y" },
        { oldText: "p\nq", newText: "r\ns" },
      ]),
    );
    assert.deepEqual(cost, { paths: ["a.ts"], lines: 6, opaque: false });
  });

  it("treats an empty side as zero lines, not as unreadable", () => {
    // Pure insertion and pure deletion are both legitimate.
    const insert = estimateChange("edit", edit("a.ts", [{ oldText: "", newText: "new\nlines" }]));
    assert.deepEqual(insert, { paths: ["a.ts"], lines: 2, opaque: false });
    const remove = estimateChange("edit", edit("a.ts", [{ oldText: "gone\nnow", newText: "" }]));
    assert.deepEqual(remove, { paths: ["a.ts"], lines: 2, opaque: false });
  });

  it("has no hunks to price when edits is empty, but still names the file", () => {
    assert.deepEqual(estimateChange("edit", edit("a.ts", [])), {
      paths: ["a.ts"],
      lines: 0,
      opaque: false,
    });
  });
});

describe("estimateChange: write", () => {
  it("charges the whole content, because a full overwrite must be re-read", () => {
    const cost = estimateChange("write", { path: "a.ts", content: "1\n2\n3\n" });
    assert.deepEqual(cost, { paths: ["a.ts"], lines: 3, opaque: false });
  });

  it("prices an empty file at just its file cost", () => {
    assert.equal(price("write", { path: "a.ts", content: "" }), FILE_POINTS);
  });
});

describe("estimateChange: bash", () => {
  it("prices a mutating command as opaque, naming no files", () => {
    assert.deepEqual(estimateChange("bash", { command: "npm install" }), {
      paths: [],
      lines: 0,
      opaque: true,
    });
  });

  it("charges OPAQUE_POINTS and nothing else", () => {
    assert.equal(price("bash", { command: "rm -rf build" }), OPAQUE_POINTS);
  });

  it("is charged more than a file touch, since an unreadable change is worse", () => {
    assert.ok(OPAQUE_POINTS > FILE_POINTS);
  });

  it("honours the caller's read-only list", () => {
    // The human decides what counts as inspection; pricing follows.
    assert.equal(estimateChange("bash", { command: "npm test" }, ["npm test"]), undefined);
    assert.deepEqual(estimateChange("bash", { command: "git status" }, ["npm test"]), {
      paths: [],
      lines: 0,
      opaque: true,
    });
  });

  it("only consults the list for bash", () => {
    // An allowlist entry cannot make an edit free.
    assert.deepEqual(estimateChange("write", { path: "a.ts", content: "x" }, ["write"]), {
      paths: ["a.ts"],
      lines: 1,
      opaque: false,
    });
  });
});

describe("estimateChange: unreadable input errs toward oversight", () => {
  // Every case here is a tool we know mutates, with an input we cannot price.
  // None of them may return undefined (that would mean "no change") and none
  // may price at zero.
  const cases: [string, string, unknown][] = [
    ["edit", "not an object", "nonsense"],
    ["edit", "missing path", { edits: [] }],
    ["edit", "missing edits", { path: "a.ts" }],
    ["edit", "edits is not an array", { path: "a.ts", edits: "x" }],
    ["edit", "a hunk is not an object", { path: "a.ts", edits: ["x"] }],
    ["write", "missing path", { content: "x" }],
    ["write", "missing content", { path: "a.ts" }],
    ["write", "null input", null],
    ["bash", "missing command", {}],
    ["bash", "array input", []],
  ];

  for (const [tool, label, input] of cases) {
    it(`${tool}: ${label}`, () => {
      const cost = estimateChange(tool, input);
      assert.notEqual(cost, undefined, "must not read as a non-change");
      assert.equal(cost?.opaque, true, "must be flagged opaque");
      assert.ok((price(tool, input) ?? 0) >= OPAQUE_POINTS, "must not be free");
    });
  }
});

describe("pointsFor: repeated files in one window", () => {
  const cost = { paths: ["a.ts"], lines: 10, opaque: false };

  it("charges the file the first time it is touched", () => {
    assert.equal(pointsFor(cost, 1), FILE_POINTS + 10);
  });

  it("charges only lines when the file was already counted this window", () => {
    // This is what stops an iterative loop on one file from inflating the score.
    assert.equal(pointsFor(cost, 0), 10);
  });
});

describe("calibration: the cases that drove the redesign", () => {
  const BUDGET = 200;

  it("5 one-line edits to one file stay silent (v2 blocked here)", () => {
    const hunk = [{ oldText: "old", newText: "new" }];
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const cost = estimateChange("edit", edit("a.ts", hunk));
      assert.ok(cost);
      // Only the first touch of a.ts pays FILE_POINTS.
      total += pointsFor(cost, i === 0 ? 1 : 0);
    }
    assert.equal(total, FILE_POINTS + 10);
    assert.ok(total < BUDGET / 2, `${total} should not even reach the soft tier`);
  });

  it("3 files at ~25 diff lines each land just under budget", () => {
    const hunk = [{ oldText: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl", newText: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm" }];
    let total = 0;
    for (const path of ["a.ts", "b.ts", "c.ts"]) {
      const cost = estimateChange("edit", edit(path, hunk));
      assert.ok(cost);
      total += pointsFor(cost, 1);
    }
    // 3 * (40 + 25) = 195
    assert.equal(total, 195);
    assert.ok(total < BUDGET, "under budget");
    assert.ok(total >= BUDGET / 2, "but well into the soft-nag tier");
  });

  it("one 400-line write blows past budget on its own (v2 counted it as 1 of 5)", () => {
    const content = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const total = price("write", { path: "big.ts", content });
    assert.equal(total, FILE_POINTS + 400);
    assert.ok((total ?? 0) >= BUDGET * 2, "should reach the hard-block tier");
  });
});

describe("pointsForWorkingTree", () => {
  it("prices a working tree with the same weights as a tool call", () => {
    // The two drivers must never disagree about what "a lot to read" means,
    // because they share one reviewBudget.
    const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const viaTree = pointsForWorkingTree({ files: 1, insertions: 10, deletions: 0 });
    const viaTool = price("write", { path: "a.ts", content: tenLines });
    assert.equal(viaTree, viaTool);
  });

  it("counts both sides of the diff", () => {
    assert.equal(
      pointsForWorkingTree({ files: 1, insertions: 30, deletions: 20 }),
      FILE_POINTS + 50,
    );
  });

  it("charges each distinct file", () => {
    assert.equal(pointsForWorkingTree({ files: 3, insertions: 0, deletions: 0 }), 3 * FILE_POINTS);
  });

  it("is zero for a clean tree", () => {
    assert.equal(pointsForWorkingTree({ files: 0, insertions: 0, deletions: 0 }), 0);
  });

  it("reaches the nudge tier at roughly three files of real work", () => {
    // Calibration sanity against the default budget of 200: soft at 100.
    const load = pointsForWorkingTree({ files: 3, insertions: 20, deletions: 5 });
    assert.equal(load, 145);
    assert.ok(load >= 100 && load < 200, "should nudge, not yet trigger");
  });

  it("reaches the auto-trigger tier on a substantial session", () => {
    const load = pointsForWorkingTree({ files: 5, insertions: 180, deletions: 40 });
    assert.ok(load >= 400, `${load} should auto-trigger against a budget of 200`);
  });
});
