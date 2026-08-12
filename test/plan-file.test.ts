import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfigFs } from "../core/config.ts";
import {
  planFileName,
  planPath,
  plansDir,
  randomPlanId,
  renderPlanMarkdown,
  slugifySummary,
  writePlan,
} from "../core/plan-file.ts";
import { formatPlan, type PlanSpec } from "../core/prompts.ts";

const PLAN: PlanSpec = {
  summary: "Wrap the sync client in a retry.",
  context: "The client retries nothing today.",
  steps: ["Add the retry helper", "Wire it into the client"],
  decisions: ["Retry on 5xx only"],
  openQuestions: ["Timeout value?"],
  risks: ["Might change request timing"],
};

const AT = new Date("2025-06-01T12:34:56.000Z").getTime();
const NOW = () => AT;

/** In-memory ConfigFs; the failure seams are injected per-test. */
function fakeFs(over: Partial<ConfigFs> = {}): { fs: ConfigFs; files: Map<string, string> } {
  const files = new Map<string, string>();
  const fs: ConfigFs = {
    readFileSync: (p) => files.get(p) ?? "",
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    mkdirSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {},
    copyFileSync: () => {},
    ...over,
  };
  return { fs, files };
}

const DIR = "/proj";

describe("plan file paths", () => {
  it("keeps plans under .pear/plans in the project", () => {
    assert.equal(plansDir(DIR), "/proj/.pear/plans");
    assert.equal(planPath(DIR, "a-b-3f9a2c.md"), "/proj/.pear/plans/a-b-3f9a2c.md");
  });
});

describe("slugifySummary", () => {
  it("reads as words a human can scan in a directory listing", () => {
    assert.equal(slugifySummary("Wrap the sync client in a retry."), "wrap-the-sync-client-in-a-retry");
  });

  it("collapses punctuation and trims the edges", () => {
    assert.equal(slugifySummary("  Fix: the //thing// (again)!  "), "fix-the-thing-again");
  });

  it("caps the length, cutting at a whole word", () => {
    const slug = slugifySummary(
      "Teach the bash classifier to interpret pipelines and chains of commands",
    );
    assert.ok(slug.length <= 40, slug);
    assert.equal(slug, "teach-the-bash-classifier-to-interpret");
    assert.ok(!slug.endsWith("-"), "never a trailing dash");
  });

  it("does not shred a long first word to find a boundary", () => {
    // No dash worth cutting at, so the cap wins over the whole-word rule.
    const slug = slugifySummary(`${"a".repeat(60)} b`);
    assert.equal(slug, "a".repeat(40));
  });

  it("falls back to a name rather than an empty one", () => {
    // The id carries the identity, so an unusable summary is not an error.
    assert.equal(slugifySummary(""), "plan");
    assert.equal(slugifySummary("!!! ???"), "plan");
    assert.equal(slugifySummary("計画"), "plan");
  });
});

describe("randomPlanId", () => {
  it("is six base36 characters, padded", () => {
    // The bottom of the range is what needs padding; the top only has to stay
    // inside six digits, and asserting an exact 'zzzzzz' would be asserting
    // float precision rather than the id.
    assert.equal(randomPlanId(() => 0), "000000");
    assert.match(randomPlanId(() => 0.999999999), /^zzzzz[0-9a-z]$/);
    assert.match(randomPlanId(), /^[0-9a-z]{6}$/);
  });

  it("is drawn from the injected source, so tests are deterministic", () => {
    const seq = [0.5, 0.5];
    let i = 0;
    const random = () => seq[i++] ?? 0;
    assert.equal(randomPlanId(random), randomPlanId(random));
  });
});

describe("planFileName", () => {
  it("joins the readable half and the identifying half", () => {
    assert.equal(
      planFileName("Wrap the sync client in a retry.", () => 0),
      "wrap-the-sync-client-in-a-retry-000000.md",
    );
  });

  it("separates two plans that open with the same words", () => {
    const a = planFileName("Same words", () => 0);
    const b = planFileName("Same words", () => 0.5);
    assert.notEqual(a, b);
  });
});

describe("renderPlanMarkdown", () => {
  it("says draft or approved in the header, because the file is rewritten", () => {
    assert.match(renderPlanMarkdown(PLAN, AT, "draft"), /^# pear plan · draft · 2025-06-01T12:34:56\.000Z\n\n/);
    assert.match(
      renderPlanMarkdown(PLAN, AT, "approved"),
      /^# pear plan · approved · 2025-06-01T12:34:56\.000Z\n\n/,
    );
  });

  it("carries the full document", () => {
    assert.ok(renderPlanMarkdown(PLAN, AT, "draft").includes(formatPlan(PLAN)));
  });
});

describe("writePlan", () => {
  const NAME = "wrap-the-sync-client-in-a-retry-3f9a2c.md";

  it("writes the proposal to its own file, creating the directory", () => {
    const made: string[] = [];
    const { fs, files } = fakeFs({ mkdirSync: (p) => void made.push(p) });
    const path = writePlan(DIR, PLAN, NAME, "draft", fs, NOW);
    assert.equal(path, `/proj/.pear/plans/${NAME}`);
    assert.deepEqual(made, ["/proj/.pear/plans"]);
    assert.equal(files.get(path), renderPlanMarkdown(PLAN, AT, "draft"));
  });

  it("rewrites the same file for a revision and again on approval", () => {
    // The name is the caller's to hold: one plan, one file, whatever the
    // summary is reworded to along the way.
    const { fs, files } = fakeFs();
    writePlan(DIR, PLAN, NAME, "draft", fs, NOW);
    const revised: PlanSpec = { ...PLAN, summary: "Reworded entirely", steps: ["One step"] };
    writePlan(DIR, revised, NAME, "draft", fs, NOW);
    writePlan(DIR, revised, NAME, "approved", fs, NOW);

    assert.deepEqual([...files.keys()], [`/proj/.pear/plans/${NAME}`], "no second file appears");
    const written = files.get(`/proj/.pear/plans/${NAME}`) ?? "";
    assert.match(written, /# pear plan · approved/);
    assert.ok(written.includes("One step"), "the latest revision is what survives");
  });

  it("throws when the directory cannot be created", () => {
    const { fs } = fakeFs({
      mkdirSync: () => {
        throw new Error("EACCES");
      },
    });
    assert.throws(() => writePlan(DIR, PLAN, NAME, "draft", fs, NOW), /EACCES/);
  });

  it("throws when the write fails", () => {
    const { fs } = fakeFs({
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
    });
    assert.throws(() => writePlan(DIR, PLAN, NAME, "approved", fs, NOW), /ENOSPC/);
  });
});
