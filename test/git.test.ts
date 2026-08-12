import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  captureGitState,
  changedLineStats,
  isGitRepo,
  isPearBookkeeping,
  parsePorcelainV2,
  worktreeToken,
  workingDiffText,
} from "../core/git.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pear-git-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commit(dir: string, message = "c"): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

function tokenOf(dir: string, path: string): string {
  const state = captureGitState(dir);
  assert.ok(state.ok, "expected a successful capture");
  const token = state.files.get(path);
  assert.ok(token !== undefined, `expected a token for ${path}`);
  return token;
}

describe("captureGitState — repository status", () => {
  it("distinguishes a clean repo from a git failure", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);

    const clean = captureGitState(dir);
    assert.equal(clean.ok, true);
    assert.ok(clean.ok && clean.files.size === 0, "clean repo yields an empty map, not an error");
  });

  it("reports not-a-repo distinctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-nogit-"));
    const state = captureGitState(dir);
    assert.equal(state.ok, false);
    assert.ok(!state.ok && state.reason === "not-a-repo");
    assert.equal(isGitRepo(dir), false);
  });

  it("works in an unborn repo (no commits yet)", () => {
    const dir = repo();
    writeFileSync(join(dir, "new.txt"), "hi\n");
    const state = captureGitState(dir);
    assert.ok(state.ok);
    assert.ok(state.ok && state.files.has("new.txt"));
  });
});

describe("captureGitState — change kinds", () => {
  it("detects an untracked file with no oids", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "x\n");
    commit(dir);
    writeFileSync(join(dir, "new.txt"), "hello\n");

    const token = tokenOf(dir, "new.txt");
    assert.match(token, /^\?\?:-:h:/, "untracked token records no index oid");
  });

  it("detects a worktree modification", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "a.txt"), "two\n");
    assert.match(tokenOf(dir, "a.txt"), /^\.M:/);
  });

  it("distinguishes two different staged versions with identical worktree state", () => {
    // The case a status-only token cannot see: stage v2, then stage v3, with
    // the worktree matching the index both times.
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);

    writeFileSync(join(dir, "a.txt"), "two\n");
    git(dir, "add", "a.txt");
    const staged2 = tokenOf(dir, "a.txt");

    writeFileSync(join(dir, "a.txt"), "three\n");
    git(dir, "add", "a.txt");
    const staged3 = tokenOf(dir, "a.txt");

    assert.notEqual(staged2, staged3, "index oid must make staged versions distinguishable");
  });

  it("detects a deletion", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    rmSync(join(dir, "a.txt"));
    assert.match(tokenOf(dir, "a.txt"), /:D$/);
  });

  it("detects a rename as new path plus deleted original", () => {
    const dir = repo();
    writeFileSync(join(dir, "old.txt"), "some reasonably unique content here\n");
    commit(dir);
    git(dir, "mv", "old.txt", "new.txt");

    const state = captureGitState(dir);
    assert.ok(state.ok);
    if (!state.ok) return;
    assert.ok(state.files.has("new.txt"), "new path present");
    assert.ok(state.files.has("old.txt"), "original path present");
    assert.match(state.files.get("old.txt") ?? "", /:D$/, "original marked deleted");
  });

  it("detects a symlink by its target", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    symlinkSync("a.txt", join(dir, "link"));
    assert.match(tokenOf(dir, "link"), /:l:/);
  });

  it("detects a type change from file to symlink", () => {
    const dir = repo();
    writeFileSync(join(dir, "f"), "content\n");
    commit(dir);
    rmSync(join(dir, "f"));
    symlinkSync("elsewhere", join(dir, "f"));
    assert.match(tokenOf(dir, "f"), /:l:/);
  });

  it("hashes binary content without decoding it", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "x\n");
    commit(dir);
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x80]));
    assert.match(tokenOf(dir, "blob.bin"), /^\?\?:-:h:/);
  });

  it("records unmerged paths as always-changed", () => {
    const dir = repo();
    writeFileSync(join(dir, "f.txt"), "base\n");
    commit(dir, "base");
    git(dir, "checkout", "-q", "-b", "other");
    writeFileSync(join(dir, "f.txt"), "theirs\n");
    commit(dir, "theirs");
    git(dir, "checkout", "-q", "-");
    writeFileSync(join(dir, "f.txt"), "ours\n");
    commit(dir, "ours");
    try {
      git(dir, "merge", "other");
    } catch {
      /* expected conflict */
    }
    assert.match(tokenOf(dir, "f.txt"), /^u:/);
  });

  it("excludes ignored files", () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
    commit(dir);
    writeFileSync(join(dir, "secret.txt"), "shh\n");

    const state = captureGitState(dir);
    assert.ok(state.ok);
    assert.ok(state.ok && !state.files.has("secret.txt"));
  });

  it("keeps a dirty pre-existing tree out of the first checkpoint's delta", () => {
    // Baseline captured while already dirty, then nothing else changes.
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "a.txt"), "dirty\n");

    const baseline = captureGitState(dir);
    const later = captureGitState(dir);
    assert.ok(baseline.ok && later.ok);
    if (!baseline.ok || !later.ok) return;

    const changed = [...later.files].filter(([p, t]) => baseline.files.get(p) !== t);
    assert.deepEqual(changed, [], "pre-existing dirt is in the baseline, not the delta");
  });
});

describe("worktreeToken", () => {
  it("reports a missing file as deleted, not as uncertain", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-tok-"));
    assert.equal(worktreeToken(dir, "nope.txt"), "D");
  });

  it("reports an unreadable file conservatively", { skip: process.getuid?.() === 0 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-tok-"));
    const p = join(dir, "locked.txt");
    writeFileSync(p, "secret\n");
    chmodSync(p, 0o000);
    try {
      assert.match(worktreeToken(dir, "locked.txt"), /^unreadable:/);
    } finally {
      chmodSync(p, 0o600);
    }
  });

  it("reports a directory distinctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-tok-"));
    mkdirSync(join(dir, "sub"));
    assert.equal(worktreeToken(dir, "sub"), "dir");
  });
});

describe("parsePorcelainV2", () => {
  it("keeps records aligned across a rename's extra NUL field", () => {
    // A rename record's original path is a separate NUL-delimited field; a
    // naive split desynchronises every record after it.
    const rec2 =
      "2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100 new.txt";
    const rec1 =
      "1 .M N... 100644 100644 100644 3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 after.txt";
    const out = `${rec2}\0old.txt\0${rec1}\0? untracked.txt\0`;

    const parsed = parsePorcelainV2(out);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0]?.kind, "2");
    assert.equal(parsed[0]?.path, "new.txt");
    assert.equal(parsed[0]?.origPath, "old.txt");
    assert.equal(parsed[1]?.kind, "1");
    assert.equal(parsed[1]?.path, "after.txt", "record after a rename must stay aligned");
    assert.equal(parsed[2]?.kind, "?");
    assert.equal(parsed[2]?.path, "untracked.txt");
  });

  it("handles paths containing spaces", () => {
    const rec =
      "1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 a file with spaces.txt";
    const parsed = parsePorcelainV2(`${rec}\0`);
    assert.equal(parsed[0]?.path, "a file with spaces.txt");
  });

  it("ignores headers and ignored-file records", () => {
    const parsed = parsePorcelainV2("# branch.oid abc\0! ignored.txt\0");
    assert.deepEqual(parsed, []);
  });
});

describe("changedLineStats", () => {
  const stats = (dir: string) => {
    const result = changedLineStats(dir);
    assert.ok(result.ok, "expected a successful read");
    return result.stats;
  };

  it("reports a clean tree as nothing to review", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    assert.deepEqual(stats(dir), { files: 0, insertions: 0, deletions: 0 });
  });

  it("counts insertions and deletions on a tracked file", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    commit(dir);
    writeFileSync(join(dir, "a.txt"), "one\nCHANGED\nthree\nfour\n");
    assert.deepEqual(stats(dir), { files: 1, insertions: 2, deletions: 1 });
  });

  it("counts a staged change, not just an unstaged one", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    git(dir, "add", "-A");
    assert.deepEqual(stats(dir), { files: 1, insertions: 1, deletions: 0 });
  });

  it("counts an untracked file, which git diff cannot see", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "new.txt"), "1\n2\n3\n");
    assert.deepEqual(stats(dir), { files: 1, insertions: 3, deletions: 0 });
  });

  it("counts a final line with no trailing newline", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "new.txt"), "1\n2");
    assert.equal(stats(dir).insertions, 2);
  });

  it("treats an empty untracked file as a file with no lines", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "empty.txt"), "");
    assert.deepEqual(stats(dir), { files: 1, insertions: 0, deletions: 0 });
  });

  it("charges a binary file for the file but not for bytes", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 10, 10]));
    assert.deepEqual(stats(dir), { files: 1, insertions: 0, deletions: 0 });
  });

  it("charges a tracked binary change for the file but not for bytes", () => {
    const dir = repo();
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2]));
    commit(dir);
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 9, 9, 9, 9]));
    assert.deepEqual(stats(dir), { files: 1, insertions: 0, deletions: 0 });
  });

  it("counts a deletion", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    commit(dir);
    rmSync(join(dir, "a.txt"));
    assert.deepEqual(stats(dir), { files: 1, insertions: 0, deletions: 2 });
  });

  it("counts a rename once, under its destination", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    commit(dir);
    git(dir, "mv", "a.txt", "b.txt");
    // A pure rename moves no lines; the point is that it is exactly one file.
    assert.equal(stats(dir).files, 1);
  });

  it("ignores files excluded by .gitignore", () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    commit(dir);
    mkdirSync(join(dir, "ignored"));
    writeFileSync(join(dir, "ignored", "junk.txt"), "1\n2\n3\n");
    assert.deepEqual(stats(dir), { files: 0, insertions: 0, deletions: 0 });
  });

  it("works in an unborn repo, before the first commit", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    // No commit, so HEAD does not resolve — the empty tree is the base.
    assert.deepEqual(stats(dir), { files: 1, insertions: 2, deletions: 0 });
  });

  it("counts staged content in an unborn repo", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    git(dir, "add", "-A");
    assert.deepEqual(stats(dir), { files: 1, insertions: 2, deletions: 0 });
  });

  it("sums across several files", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "b.txt"), "1\n2\n3\n");
    assert.deepEqual(stats(dir), { files: 2, insertions: 4, deletions: 0 });
  });

  it("reports a failure outside a repo rather than guessing at zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-nogit-"));
    const result = changedLineStats(dir);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "not-a-repo");
  });

  it("reports a git-error separately from not-a-repo", () => {
    const failing = () => {
      throw Object.assign(new Error("fatal: something else broke"), {
        stderr: "fatal: something else broke",
      });
    };
    const result = changedLineStats("/tmp", failing);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "git-error");
  });
});

describe("pear's own bookkeeping is not the human's work", () => {
  /** A repo with a real change and a .pear plan file that is NOT gitignored. */
  function repoWithPearPlan(): string {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    commit(dir);
    mkdirSync(join(dir, ".pear", "plans"), { recursive: true });
    writeFileSync(join(dir, ".pear", "plans", "latest.md"), "# pear plan\n");
    writeFileSync(join(dir, "new.txt"), "hello\n");
    return dir;
  }

  it("isPearBookkeeping covers the directory and its contents", () => {
    assert.equal(isPearBookkeeping(".pear"), true);
    assert.equal(isPearBookkeeping(".pear/plans/latest.md"), true);
    assert.equal(isPearBookkeeping("pear/notes.md"), false, "a sibling dir is fine");
    assert.equal(isPearBookkeeping("src/a.ts"), false);
  });

  it("captureGitState skips untracked files under .pear but keeps real changes", () => {
    const dir = repoWithPearPlan();
    const state = captureGitState(dir);
    assert.ok(state.ok);
    assert.ok(state.ok && !state.files.has(".pear/plans/latest.md"));
    assert.ok(state.ok && state.files.has("new.txt"), "the human's file still shows");
  });

  it("captureGitState ignores a tracked .pear modification", () => {
    const dir = repo();
    mkdirSync(join(dir, ".pear", "plans"), { recursive: true });
    writeFileSync(join(dir, ".pear", "plans", "latest.md"), "v1\n");
    commit(dir);
    writeFileSync(join(dir, ".pear", "plans", "latest.md"), "v2\n");
    const state = captureGitState(dir);
    assert.ok(state.ok);
    assert.ok(state.ok && state.files.size === 0);
  });

  it("changedLineStats ignores .pear even when it is not gitignored", () => {
    const dir = repoWithPearPlan();
    const result = changedLineStats(dir);
    assert.ok(result.ok);
    assert.deepEqual(result.stats, { files: 1, insertions: 1, deletions: 0 });
  });

  it("changedLineStats ignores a tracked .pear file's churn", () => {
    const dir = repo();
    mkdirSync(join(dir, ".pear", "plans"), { recursive: true });
    writeFileSync(join(dir, ".pear", "plans", "latest.md"), "v1\n");
    commit(dir);
    writeFileSync(join(dir, ".pear", "plans", "latest.md"), "v1\nv2\nv3\n");
    const result = changedLineStats(dir);
    assert.ok(result.ok);
    assert.deepEqual(result.stats, { files: 0, insertions: 0, deletions: 0 });
  });

  it("workingDiffText leaves pear's plan file out, untracked or tracked", () => {
    const dir = repoWithPearPlan();
    const diff = workingDiffText(dir);
    assert.ok(diff !== null);
    assert.doesNotMatch(diff, /\.pear/);
    assert.match(diff, /new\.txt/);

    git(dir, "add", ".pear");
    git(dir, "commit", "-qm", "track the plan");
    writeFileSync(join(dir, ".pear", "plans", "latest.md"), "# pear plan\nv2\n");
    const trackedDiff = workingDiffText(dir);
    assert.ok(trackedDiff !== null);
    assert.doesNotMatch(trackedDiff, /latest\.md/);
  });
});
