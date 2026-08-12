import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReadOnlyBashCommand } from "../core/bash.ts";

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
  "cat a | tee out",
  "ls && rm x",
  "ls; rm x",
  "ls || rm x",
  "cat <(rm x)",
  "cat <<EOF",
  "FOO=1 ls",
  "PATH=/tmp git status",
  "ls\nrm x",
  // quoting / escaping we cannot split reliably
  'grep "foo bar" f',
  "grep 'foo' f",
  "cat a\\ b",
  // git escape hatches that execute configured programs
  "git -c core.pager=sh log",
  "git -c diff.external=evil diff",
  "git log -p",
  "git log --patch",
  "git log --format=%x00",
  "git log --pretty=oneline",
  "git diff",
  "git show HEAD",
  "git status -o out",
  "git branch -d topic",
  "git branch --delete topic",
  "git ls-files --output=x",
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

  it("is conservative by default for anything unrecognised", () => {
    // Property: a command is only ever read-only if it is on the allowlist.
    for (const verb of ["cp", "chmod", "curl", "kill", "tee", "dd", "ln", "touch"]) {
      assert.equal(isReadOnlyBashCommand(`${verb} x y`), false, verb);
    }
  });
});
