import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createTools } from "../src/tools.ts";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || args.join(" "));
}

describe("checkpoint gate", () => {
  it("steering returns NOT EXECUTED and does not write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-tools-"));
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.ts"), "x\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "i"]);

    const prompts: string[] = [];
    const box = createTools({
      cwd: dir,
      isGit: true,
      budget: { pauseLines: 1000, pauseEdits: 1 },
      askCheckpoint: async (s) => {
        prompts.push(s);
        return "please use a different approach";
      },
    });

    const write = box.tools.find((t) => t.name === "write")!;
    await write.execute("1", { path: "b.ts", content: "hello\n" });
    assert.equal(existsSync(join(dir, "b.ts")), true);
    const r = await write.execute("2", { path: "c.ts", content: "nope\n" });
    assert.ok(prompts.length >= 1);
    const text = r.content.map((c) => ("text" in c ? c.text : "")).join("");
    assert.match(text, /NOT EXECUTED — human steering:/);
    assert.equal(existsSync(join(dir, "c.ts")), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("Enter continues and executes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pear-tools-"));
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.ts"), "x\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "i"]);

    const box = createTools({
      cwd: dir,
      isGit: true,
      budget: { pauseLines: 1000, pauseEdits: 1 },
      askCheckpoint: async () => "",
    });
    const write = box.tools.find((t) => t.name === "write")!;
    await write.execute("1", { path: "b.ts", content: "hello\n" });
    await write.execute("2", { path: "c.ts", content: "yes\n" });
    assert.equal(existsSync(join(dir, "c.ts")), true);
    rmSync(dir, { recursive: true, force: true });
  });
});
