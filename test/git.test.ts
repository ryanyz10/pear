import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  base,
  changedLines,
  diffText,
  EMPTY_TREE,
  fileStateHashes,
  isGitRepo,
  parseZPaths,
  quickStateHash,
  stateHash,
} from "../core/git.ts";

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

describe("quickStateHash", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pear-quickhash-"));
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "pear@test"]);
    git(dir, ["config", "user.name", "pear"]);
    writeFileSync(join(dir, "tracked.ts"), "one\n");
    git(dir, ["add", "tracked.ts"]);
    git(dir, ["commit", "-m", "init"]);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("changes when git status changes (a new untracked file appears)", () => {
    const h1 = quickStateHash(dir);
    writeFileSync(join(dir, "new.ts"), "x\n");
    const h2 = quickStateHash(dir);
    assert.notEqual(h1, h2);
    rmSync(join(dir, "new.ts"));
  });

  it("changes when a tracked file's size/mtime metadata changes", () => {
    writeFileSync(join(dir, "tracked.ts"), "one\n");
    const h1 = quickStateHash(dir);
    writeFileSync(join(dir, "tracked.ts"), "one\ntwo\n");
    const h2 = quickStateHash(dir);
    assert.notEqual(h1, h2);
  });

  it("changes when an untracked file's size/mtime metadata changes", () => {
    writeFileSync(join(dir, "scratch.ts"), "a\n");
    const h1 = quickStateHash(dir);
    writeFileSync(join(dir, "scratch.ts"), "a\nb\n");
    const h2 = quickStateHash(dir);
    assert.notEqual(h1, h2);
    rmSync(join(dir, "scratch.ts"));
  });

  it("never reads file contents: identical size+mtime collide despite different bytes", () => {
    const path = join(dir, "tracked.ts");
    const fixedTime = new Date(2024, 0, 1, 0, 0, 0);
    writeFileSync(path, "aaaaa");
    utimesSync(path, fixedTime, fixedTime);
    const h1 = quickStateHash(dir);
    writeFileSync(path, "bbbbb"); // same length, different bytes
    utimesSync(path, fixedTime, fixedTime);
    const h2 = quickStateHash(dir);
    assert.equal(h1, h2, "same size+mtime must collide — quickStateHash never reads content");
  });
});

describe("fileStateHashes", () => {
  it("hashes tracked-diff and untracked-content separately, omitting untouched paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-filehashes-"));
    try {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "pear@test"]);
      git(dir, ["config", "user.name", "pear"]);
      writeFileSync(join(dir, "tracked.ts"), "one\n");
      git(dir, ["add", "tracked.ts"]);
      git(dir, ["commit", "-m", "init"]);
      writeFileSync(join(dir, "tracked.ts"), "one\ntwo\n");
      writeFileSync(join(dir, "untracked.ts"), "x\n");
      const hashes = fileStateHashes(dir);
      assert.equal(hashes.size, 2);
      assert.ok(hashes.has("tracked.ts"));
      assert.ok(hashes.has("untracked.ts"));
      const h1 = hashes.get("untracked.ts");
      writeFileSync(join(dir, "untracked.ts"), "x\ny\n");
      const h2 = fileStateHashes(dir).get("untracked.ts");
      assert.notEqual(h1, h2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
