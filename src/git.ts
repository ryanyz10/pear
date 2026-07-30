import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Git's empty-tree object — unborn repos (no commits yet) diff against this. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DIFF_CAP = 200 * 1024;

function git(cwd: string, args: string[], opts: { encoding?: "utf8" | "buffer"; input?: string | Buffer } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: opts.encoding === "buffer" ? undefined : "utf8",
    input: opts.input,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}

export function isGitRepo(cwd: string): boolean {
  const r = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.status === 0 && String(r.stdout).trim() === "true";
}

export function base(cwd: string): string {
  const r = git(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (r.status === 0) return String(r.stdout).trim();
  return EMPTY_TREE;
}

/** Split NUL-delimited git -z output into path records. Rename/copy records have two pathnames. */
export function parseZPaths(buf: string | Buffer): string[] {
  const s = typeof buf === "string" ? buf : buf.toString("utf8");
  const parts = s.split("\0").filter(Boolean);
  // porcelain -z: "XY path\0" or "XY path\0orig\0" for renames. We only need pathnames for counting.
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    // status line starts with two status chars + space, or just a path for ls-files -z
    if (p.length >= 3 && p[2] === " ") {
      paths.push(p.slice(3));
      // rename/copy: next record is the other pathname
      const status = p.slice(0, 2);
      if (status.includes("R") || status.includes("C")) {
        i++;
        if (parts[i]) paths.push(parts[i]!);
      }
    } else {
      paths.push(p);
    }
  }
  return paths;
}

function untrackedPaths(cwd: string): string[] {
  const r = git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], { encoding: "buffer" });
  if (r.status !== 0) return [];
  return (r.stdout as Buffer).toString("utf8").split("\0").filter(Boolean);
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(8192, buf.length)).includes(0);
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  if (!text.endsWith("\n")) n++;
  return n;
}

function shortstatLines(cwd: string, b: string): number {
  const r = git(cwd, ["diff", b, "--shortstat"]);
  const out = String(r.stdout ?? "");
  const ins = /(\d+) insertion/.exec(out);
  const del = /(\d+) deletion/.exec(out);
  return (ins ? +ins[1]! : 0) + (del ? +del[1]! : 0);
}

function untrackedLineCount(cwd: string): number {
  let total = 0;
  for (const rel of untrackedPaths(cwd)) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) continue;
    try {
      const buf = readFileSync(abs);
      if (isBinary(buf)) continue;
      total += countLines(buf.toString("utf8"));
    } catch {
      /* skip unreadable */
    }
  }
  return total;
}

export function changedLines(cwd: string): number {
  return shortstatLines(cwd, base(cwd)) + untrackedLineCount(cwd);
}

function untrackedPayload(cwd: string): string {
  const parts: string[] = [];
  for (const rel of untrackedPaths(cwd)) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) continue;
    try {
      const buf = readFileSync(abs);
      if (isBinary(buf)) {
        // ponytail: same-size binary edits past the content cap can be missed; upgrade = full-content hashing
        parts.push(`=== ${rel} ===\n[binary file, ${buf.length} bytes]\n`);
      } else {
        parts.push(`=== ${rel} ===\n${buf.toString("utf8")}\n`);
      }
    } catch {
      parts.push(`=== ${rel} ===\n[unreadable]\n`);
    }
  }
  return parts.join("");
}

export function stateHash(cwd: string): string {
  const b = base(cwd);
  const tracked = String(git(cwd, ["diff", b]).stdout ?? "");
  const untracked = untrackedPayload(cwd);
  // Include path+size framing for untracked files so renames/empties matter.
  const framing = untrackedPaths(cwd)
    .map((rel) => {
      try {
        const buf = readFileSync(join(cwd, rel));
        return `${rel}:${buf.length}`;
      } catch {
        return `${rel}:?`;
      }
    })
    .join("\n");
  return createHash("sha1").update(tracked).update("\0").update(framing).update("\0").update(untracked).digest("hex");
}

export function diffText(cwd: string): string {
  const b = base(cwd);
  let text = String(git(cwd, ["diff", b]).stdout ?? "");
  const ut = untrackedPayload(cwd);
  if (ut) text += (text.endsWith("\n") ? "" : "\n") + ut;
  if (Buffer.byteLength(text) > DIFF_CAP) {
    const sliced = Buffer.from(text).subarray(0, DIFF_CAP).toString("utf8");
    return sliced + `\n... [truncated ${Buffer.byteLength(text) - DIFF_CAP} bytes]\n`;
  }
  return text;
}

/** Files touched since base (for checkpoint summaries). */
export function changedFiles(cwd: string): string[] {
  const b = base(cwd);
  const tracked = String(git(cwd, ["diff", b, "--name-only"]).stdout ?? "")
    .split("\n")
    .filter(Boolean);
  return [...new Set([...tracked, ...untrackedPaths(cwd)])];
}

export function gitOk(cwd: string): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return isGitRepo(cwd);
  } catch {
    return false;
  }
}
