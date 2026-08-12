import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_READ_ONLY_COMMANDS, isReadOnlyBashCommand } from "../core/bash.ts";

const readOnly = [
  "ls",
  "ls -la",
  "pwd",
  "cat README.md",
  "head -n 20 file.ts",
  "tail -n 5 file.ts",
  "wc -l file.ts",
  "grep foo file.ts",
  "rg pattern",
  "which node",
  "git status",
  "git status --short",
  "git log",
  "git log --oneline -n 5",
  "git rev-parse HEAD",
  "git ls-files",
  // Reading the diff is most of what inspection is for. These can invoke a
  // pager or an external diff driver via repo git config; see core/bash.ts.
  "git diff",
  "git diff --stat HEAD",
  "git show HEAD",
  "git log -p",
  "git log --patch",
  "git log --format=%x00",
  "git log --pretty=oneline",
  // Quoted and escaped arguments: the tokenizer reads these the way the shell
  // would, so refusing them was never anything but a limitation.
  'grep "foo bar" f',
  "grep 'foo' f",
  "cat a\\ b",
  'git log --grep="fix the thing"',
  // Bare -o means "only matching", "long without group" and "or" here — it is
  // read as an output flag for git alone.
  "grep -o foo f",
  "ls -o",
  // Composition of read-only commands reads exactly what its parts read.
  "ls -R core | head -50",
  "git log --oneline | head -5",
  "git diff | wc -l",
  "cat f | grep foo | head -n 3",
  "grep foo f && wc -l f",
  "ls; pwd",
  "git status || git log",
];

const mutating = [
  // obviously destructive
  "rm -rf /",
  "mv a b",
  "npm install",
  // dual-purpose programs excluded wholesale
  "find . -delete",
  "find . -exec rm {} ;",
  "sort -o out in",
  "xargs rm",
  "echo hi",
  "sed -i s/a/b/ f",
  "awk '{print}' f",
  // shell syntax we refuse to reason about
  "cat $(rm -rf x)",
  "cat `rm -rf x`",
  "cat a > b",
  "cat a >> b",
  "cat a < b",
  // One refused segment refuses the whole chain, wherever it sits.
  "cat a | tee out",
  "ls && rm x",
  "ls; rm x",
  "ls || rm x",
  "rm x | ls",
  "ls | head > out",
  "ls | FOO=1 head",
  "ls | /bin/head",
  "ls | git diff -o notes.md",
  // Structure we still decline to reason about, and empty segments.
  "ls & head",
  "ls |& head",
  "ls |",
  "| ls",
  "ls ;; pwd",
  "(ls)",
  "cat <(rm x)",
  "cat <<EOF",
  "FOO=1 ls",
  "PATH=/tmp git status",
  "ls\nrm x",
  // expansion the tokenizer cannot flag for us, so it is rejected before parsing
  "cat ${HOME}/x",
  "echo ${HOME}",
  "ls $HOME",
  "grep foo $file",
  // `git -c` injects config before the subcommand, so the leading tokens no
  // longer match any entry — the prefix rule rejects these for free.
  "git -c core.pager=sh log",
  "git -c diff.external=evil diff",
  // Not in the default list: git branch deletes and renames under -d/-m.
  "git branch",
  "git branch -d topic",
  "git branch --delete topic",
  // Naming a file to write is never read-only, whatever the allowlist says.
  "git status -o out",
  "git ls-files --output=x",
  "git diff --output=notes.md",
  "git diff -o notes.md",
  // path-qualified binaries
  "/bin/ls",
  "./script.sh",
  // unknown verbs
  "frobnicate",
  "docker ps",
  // non-ascii / control characters
  "ls\u00a0-la",
  "ls\t-la",
  // empty
  "",
  "   ",
];

describe("isReadOnlyBashCommand", () => {
  for (const cmd of readOnly) {
    it(`read-only: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isReadOnlyBashCommand(cmd), true);
    });
  }

  for (const cmd of mutating) {
    it(`mutating: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isReadOnlyBashCommand(cmd), false);
    });
  }

  it("rejects expansion before parsing, because the parser hides it", () => {
    // Both of these tokenize to innocent-looking strings: backticks are not
    // operators to shell-quote, and $ substitutes to nothing. Neither could be
    // caught after the fact, so the raw string is scanned first.
    assert.equal(isReadOnlyBashCommand("cat `rm -rf x`"), false);
    assert.equal(isReadOnlyBashCommand("cat `rm -rf x`", ["cat"]), false);
    assert.equal(isReadOnlyBashCommand("echo ${HOME}", ["echo"]), false);
  });

  it("rejects structure that is not a plain sequence of commands", () => {
    // Redirects, globs, comments and backgrounding all come back as objects,
    // and only the four control operators are read as segment separators.
    for (const cmd of ["ls > out", "ls *.ts", "ls # note", "ls & ", "ls > out | head"]) {
      assert.equal(isReadOnlyBashCommand(cmd, ["ls", "head"]), false, cmd);
    }
  });

  it("admits a chain only when every segment would be admitted alone", () => {
    // The verbs are what the allowlist decides; composition is not.
    assert.equal(isReadOnlyBashCommand("ls | head", ["ls", "head"]), true);
    assert.equal(isReadOnlyBashCommand("ls | head", ["ls"]), false, "head is not allowed");
    assert.equal(isReadOnlyBashCommand("head f | ls", ["ls"]), false, "nor is it in front");
    // Each segment gets the whole gate, not just the allowlist.
    assert.equal(isReadOnlyBashCommand("ls | head --output=x", ["ls", "head"]), false);
    // An empty segment is a syntax we cannot price, so it fails with the rest.
    for (const cmd of ["ls |", "| ls", "ls && && ls"]) {
      assert.equal(isReadOnlyBashCommand(cmd, ["ls"]), false, cmd);
    }
  });

  it("matches entries as token prefixes, not as whole commands", () => {
    assert.equal(isReadOnlyBashCommand("git status", ["git status"]), true);
    assert.equal(isReadOnlyBashCommand("git status --short -b", ["git status"]), true);
    // A shorter entry is a broader permission, and a longer one is narrower.
    assert.equal(isReadOnlyBashCommand("git push", ["git status"]), false);
    assert.equal(isReadOnlyBashCommand("git push", ["git"]), true);
    // Prefixes are matched per token, never per character.
    assert.equal(isReadOnlyBashCommand("gitk", ["git"]), false);
    assert.equal(isReadOnlyBashCommand("lsof", ["ls"]), false);
  });

  it("honours a caller's list instead of the defaults", () => {
    assert.equal(isReadOnlyBashCommand("docker ps", ["docker ps"]), true);
    // The list replaces the defaults rather than adding to them, so it can
    // take permissions away as well as grant them.
    assert.equal(isReadOnlyBashCommand("ls", ["docker ps"]), false);
    assert.equal(isReadOnlyBashCommand("ls", []), false);
  });

  it("ignores blank and whitespace-only entries", () => {
    assert.equal(isReadOnlyBashCommand("ls", ["", "   "]), false);
    assert.equal(isReadOnlyBashCommand("ls", ["  ls  "]), true);
  });

  it("refuses a named output file even for an allowlisted command", () => {
    assert.equal(isReadOnlyBashCommand("cat --output=x f", ["cat"]), false);
    assert.equal(isReadOnlyBashCommand("git diff -o x", ["git diff"]), false);
    // ...but bare -o is only an output flag for git.
    assert.equal(isReadOnlyBashCommand("grep -o foo f", ["grep"]), true);
    assert.equal(isReadOnlyBashCommand("find . -name a -o -name b", ["find"]), true);
  });

  it("applies the syntax gate before the list, whatever is on it", () => {
    // Rule 1 is not configurable: an allowlisted verb inside untrustworthy
    // shell syntax is still refused.
    assert.equal(isReadOnlyBashCommand("rm -rf /", ["rm"]), true, "the list is the policy");
    // ...but a chain of allowlisted commands is now the list's decision too.
    assert.equal(isReadOnlyBashCommand("ls; rm x", ["ls", "rm"]), true, "the list is the policy");
    assert.equal(isReadOnlyBashCommand("ls; rm x", ["ls"]), false);
    assert.equal(isReadOnlyBashCommand("ls > out", ["ls"]), false);
    assert.equal(isReadOnlyBashCommand("FOO=1 ls", ["ls", "FOO=1"]), false);
    assert.equal(isReadOnlyBashCommand("cat --output=out", ["cat"]), false);
  });

  it("ships defaults that read the tree without writing to it", () => {
    assert.ok(DEFAULT_READ_ONLY_COMMANDS.includes("git diff"));
    assert.ok(DEFAULT_READ_ONLY_COMMANDS.includes("git show"));
    assert.ok(!DEFAULT_READ_ONLY_COMMANDS.includes("git branch"), "deletes under -d");
  });

  it("is conservative by default for anything unrecognised", () => {
    // Property: a command is only ever read-only if it is on the allowlist.
    for (const verb of ["cp", "chmod", "curl", "kill", "tee", "dd", "ln", "touch"]) {
      assert.equal(isReadOnlyBashCommand(`${verb} x y`), false, verb);
    }
  });
});
