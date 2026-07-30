import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  base,
  changedLines,
  diffText,
  EMPTY_TREE,
  isGitRepo,
  parseZPaths,
  stateHash,
} from "../src/git.ts";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(" "));
  return r.stdout;
}

describe("git helpers", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pear-git-"));
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "pear@test"]);
    git(dir, ["config", "user.name", "pear"]);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects git repo and unborn HEAD uses empty tree", () => {
    assert.equal(isGitRepo(dir), true);
    assert.equal(base(dir), EMPTY_TREE);
  });

  it("counts untracked lines", () => {
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
    assert.ok(changedLines(dir) >= 3);
    assert.ok(diffText(dir).includes("a.ts"));
  });

  it("stateHash is content-sensitive for dirty files", () => {
    // Commit so we have a tracked baseline.
    git(dir, ["add", "a.ts"]);
    git(dir, ["commit", "-m", "init"]);
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");
    const h1 = stateHash(dir);
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\nfive\n");
    const h2 = stateHash(dir);
    assert.notEqual(h1, h2);
  });

  it("counts staged and unstaged", () => {
    writeFileSync(join(dir, "b.ts"), "x\n");
    git(dir, ["add", "b.ts"]);
    writeFileSync(join(dir, "b.ts"), "x\ny\n");
    assert.ok(changedLines(dir) >= 1);
  });

  it("parseZPaths handles rename two-pathname records", () => {
    // Simulated porcelain -z rename: "R  new\0old\0"
    const paths = parseZPaths("R  new.ts\0old.ts\0");
    assert.deepEqual(paths, ["new.ts", "old.ts"]);
  });

  it("skips untracked binaries in diffText", () => {
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 4]));
    const d = diffText(dir);
    assert.ok(d.includes("[binary file"));
    assert.ok(!d.includes("\u0000"));
  });
});
