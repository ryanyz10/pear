import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfigFs } from "../core/config.ts";
import {
  approvedPlanPath,
  latestPlanPath,
  renderPlanMarkdown,
  writePlanApproved,
  writePlanDraft,
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
    assert.equal(latestPlanPath(DIR), "/proj/.pear/plans/latest.md");
  });

  it("timestamps approved snapshots, filename-safe", () => {
    assert.equal(approvedPlanPath(DIR, AT), "/proj/.pear/plans/approved-2025-06-01T12-34-56-000Z.md");
  });
});

describe("renderPlanMarkdown", () => {
  it("leads with a pear plan header and carries the full document", () => {
    const text = renderPlanMarkdown(PLAN, AT);
    assert.match(text, /^# pear plan · 2025-06-01T12:34:56\.000Z\n\n/);
    assert.ok(text.includes(formatPlan(PLAN)), "the whole plan document is inside");
  });
});

describe("writePlanDraft", () => {
  it("writes the proposal to latest.md, creating the directory", () => {
    const { fs, files } = fakeFs();
    writePlanDraft(DIR, PLAN, fs, NOW);
    const written = files.get("/proj/.pear/plans/latest.md");
    assert.ok(written !== undefined, "latest.md exists");
    assert.equal(written, renderPlanMarkdown(PLAN, AT));
  });

  it("throws when the directory cannot be created", () => {
    const { fs } = fakeFs({
      mkdirSync: () => {
        throw new Error("EACCES");
      },
    });
    assert.throws(() => writePlanDraft(DIR, PLAN, fs, NOW), /EACCES/);
  });

  it("throws when the write fails", () => {
    const { fs } = fakeFs({
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
    });
    assert.throws(() => writePlanDraft(DIR, PLAN, fs, NOW), /ENOSPC/);
  });
});

describe("writePlanApproved", () => {
  it("writes latest.md plus a timestamped snapshot", () => {
    const { fs, files } = fakeFs();
    writePlanApproved(DIR, PLAN, fs, NOW);
    assert.equal(files.get("/proj/.pear/plans/latest.md"), renderPlanMarkdown(PLAN, AT));
    assert.equal(
      files.get("/proj/.pear/plans/approved-2025-06-01T12-34-56-000Z.md"),
      renderPlanMarkdown(PLAN, AT),
    );
  });

  it("returns the snapshot path, not latest.md", () => {
    const { fs } = fakeFs();
    assert.equal(
      writePlanApproved(DIR, PLAN, fs, NOW),
      "/proj/.pear/plans/approved-2025-06-01T12-34-56-000Z.md",
    );
  });

  it("stamps the filename and the header with ONE instant", () => {
    // A clock that moves on every read is what a real one does between two
    // calls; the snapshot's name and its contents must still agree.
    let tick = AT;
    const { fs, files } = fakeFs();
    const snapshot = writePlanApproved(DIR, PLAN, fs, () => tick++);
    const nameStamp = snapshot.replace(/^.*approved-|\.md$/g, "");
    assert.match(files.get(snapshot) ?? "", new RegExp(nameStamp.replace(/-/g, "[-:.]")));
    assert.equal(files.get(snapshot), files.get("/proj/.pear/plans/latest.md"));
  });

  it("throws when either write fails", () => {
    const { fs } = fakeFs({
      writeFileSync: () => {
        throw new Error("EACCES");
      },
    });
    assert.throws(() => writePlanApproved(DIR, PLAN, fs, NOW), /EACCES/);
  });
});
