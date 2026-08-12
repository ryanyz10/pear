/**
 * Git working-tree inspection.
 *
 * Two consumers, with deliberately different levels of trust:
 *
 * - **The checkpoint card's "files you changed" list is display-only.** A wrong
 *   or missing list produces a worse-looking card, never a wedged or bypassed
 *   loop. The agent-driver budget is priced from tool inputs and never reads
 *   git at all.
 * - **Human-driver's trigger does depend on this**, because the human's edits
 *   arrive through no tool call and git is the only witness. The bound there is
 *   the other way round: a git failure means *no trigger* — never a nag, never
 *   a block. The watcher parks rather than retrying forever.
 *
 * So the rule is: git may drive the human-driver trigger; it may never drive
 * the agent-driver gate.
 *
 * State tokens come from `git status --porcelain=v2 -z`, which is the only
 * porcelain format that exposes **index object ids**. That matters: two
 * different staged versions of a file can have identical worktree content and
 * identical status letters, and only the index oid distinguishes them.
 *
 * Token grammar (all fields are literal text, `:`-joined):
 *
 *   tracked change   `<XY>:<indexOid|->:<worktreeToken>`
 *   rename/copy      same, plus the original path emitted separately as deleted
 *   unmerged         `u:<XY>:<stage1>:<stage2>:<stage3>`   (always "changed")
 *   untracked        `??:-:<worktreeToken>`                (no oids exist)
 *   submodule        `sub:<XY>:<indexOid|->`               (pointer only)
 *
 * where `<worktreeToken>` is one of:
 *
 *   `h:<sha256>`        regular file content hash
 *   `l:<sha256>`        symlink, hash of its target
 *   `D`                 absent from the worktree (deleted)
 *   `unreadable:<why>`  could not be read; always compares as changed
 *
 * An absent object id is `-` rather than git's all-zero oid, so "no index
 * entry" is visibly different from a real oid.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { UNCERTAIN_TOKEN_PREFIX, type FileState } from "./checkpoint.ts";

export type GitState =
  | { ok: true; files: FileState }
  | { ok: false; reason: "not-a-repo" | "git-error"; detail: string };

const ABSENT_OID = "-";
const ZERO_OID = "0000000000000000000000000000000000000000";

export type GitRunner = (args: string[], cwd: string) => string;

const defaultRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

function hash(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

function normalizeOid(oid: string | undefined): string {
  if (oid === undefined || oid === "" || oid === ZERO_OID) return ABSENT_OID;
  return oid;
}

/**
 * Token for a path's current worktree state. Never throws: anything we cannot
 * read becomes an uncertain token, which the diff treats as always-changed.
 */
export function worktreeToken(cwd: string, relPath: string): string {
  const abs = join(cwd, relPath);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // ENOENT is a real, knowable state (deleted), not uncertainty.
    if (err.code === "ENOENT") return "D";
    return `${UNCERTAIN_TOKEN_PREFIX}${err.code ?? "stat-failed"}`;
  }

  if (stat.isSymbolicLink()) {
    try {
      return `l:${hash(readlinkSync(abs))}`;
    } catch (e) {
      return `${UNCERTAIN_TOKEN_PREFIX}${(e as NodeJS.ErrnoException).code ?? "readlink-failed"}`;
    }
  }

  if (stat.isDirectory()) {
    // A directory where git reported a path (e.g. a submodule working dir).
    return "dir";
  }

  try {
    // Binary content is fine: we hash bytes, never decode them.
    return `h:${hash(readFileSync(abs))}`;
  } catch (e) {
    return `${UNCERTAIN_TOKEN_PREFIX}${(e as NodeJS.ErrnoException).code ?? "read-failed"}`;
  }
}

/**
 * Split NUL-delimited porcelain v2 output into records.
 *
 * Rename/copy (`2`) records are the awkward case: the original path follows the
 * new path as a *separate* NUL-terminated field, so a naive split desynchronises
 * everything after the first rename.
 */
export function parsePorcelainV2(out: string): Array<{ kind: string; fields: string[]; path: string; origPath?: string }> {
  const parts = out.split("\0");
  const records: Array<{ kind: string; fields: string[]; path: string; origPath?: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec === undefined || rec === "") continue;
    const kind = rec[0] ?? "";

    if (kind === "1" || kind === "u") {
      // `<kind> <f1> ... <fn> <path>` — path is the remainder after the fixed fields.
      const fieldCount = kind === "1" ? 8 : 10;
      const segs = splitFirst(rec, fieldCount);
      if (segs === undefined) continue;
      records.push({ kind, fields: segs.fields, path: segs.rest });
    } else if (kind === "2") {
      // Same, but the *next* NUL-separated part is the original path.
      const segs = splitFirst(rec, 9);
      if (segs === undefined) continue;
      const origPath = parts[++i] ?? "";
      records.push({ kind, fields: segs.fields, path: segs.rest, origPath });
    } else if (kind === "?") {
      records.push({ kind, fields: [kind], path: rec.slice(2) });
    }
    // Dropped here so there is a single owner for the rule: "#" headers, "!"
    // ignored-file records (only emitted under --ignored, which we never
    // pass), and anything unrecognised.
  }

  return records;
}

/** Split a record into exactly `count` whitespace fields plus the trailing path. */
function splitFirst(rec: string, count: number): { fields: string[]; rest: string } | undefined {
  const fields: string[] = [];
  let idx = 0;
  for (let f = 0; f < count; f++) {
    const sp = rec.indexOf(" ", idx);
    if (sp === -1) return undefined;
    fields.push(rec.slice(idx, sp));
    idx = sp + 1;
  }
  return { fields, rest: rec.slice(idx) };
}

/**
 * Capture the working tree's change state.
 *
 * A clean repository is `{ ok: true, files: <empty> }` — deliberately distinct
 * from a git failure, so the UI can say "nothing changed" instead of
 * "unverified".
 *
 * Honest limitation: paths are decoded as UTF-8 JS strings. A filename with
 * invalid UTF-8 bytes may render lossily. Diffs stay self-consistent because
 * both captures decode identically, so this affects display only.
 */
export function captureGitState(cwd: string, run: GitRunner = defaultRunner): GitState {
  let out: string;
  try {
    out = run(["status", "--porcelain=v2", "-z"], cwd);
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = String(err.stderr ?? err.message ?? "git failed").trim();
    if (/not a git repository/i.test(detail)) {
      return { ok: false, reason: "not-a-repo", detail };
    }
    return { ok: false, reason: "git-error", detail };
  }

  const files: FileState = new Map();

  for (const rec of parsePorcelainV2(out)) {
    if (rec.kind === "1" || rec.kind === "2") {
      // fields: <kind> <XY> <sub> <mH> <mI> <mW> <hH> <hI> [<Xscore>]
      const xy = rec.fields[1] ?? "??";
      const sub = rec.fields[2] ?? "N...";
      const indexOid = normalizeOid(rec.fields[7]);

      if (sub.startsWith("S")) {
        // Submodule: record the pointer, never scan inside it.
        files.set(rec.path, `sub:${xy}:${indexOid}`);
      } else {
        files.set(rec.path, `${xy}:${indexOid}:${worktreeToken(cwd, rec.path)}`);
      }

      if (rec.kind === "2" && rec.origPath) {
        // The source of a rename/copy no longer exists at its old path.
        files.set(rec.origPath, `${xy}:${ABSENT_OID}:D`);
      }
    } else if (rec.kind === "u") {
      // Unmerged: three stages, no single "current" content worth hashing.
      const xy = rec.fields[1] ?? "UU";
      const s1 = normalizeOid(rec.fields[7]);
      const s2 = normalizeOid(rec.fields[8]);
      const s3 = normalizeOid(rec.fields[9]);
      files.set(rec.path, `u:${xy}:${s1}:${s2}:${s3}`);
    } else if (rec.kind === "?") {
      // Untracked: porcelain gives no oids at all.
      files.set(rec.path, `??:${ABSENT_OID}:${worktreeToken(cwd, rec.path)}`);
    }
    // "!" ignored files are excluded by design.
  }

  return { ok: true, files };
}

/**
 * How much a human would have to read to review the working tree.
 *
 * Unlike `captureGitState`, this counts *lines*, because that is what the
 * review-load score is priced in. It is only used by human-driver, where there
 * are no tool inputs to price from.
 *
 * `files` counts distinct paths, not diff hunks, matching how `core/load.ts`
 * charges `FILE_POINTS`.
 */
export type LineStats = {
  files: number;
  insertions: number;
  deletions: number;
};

export type LineStatsResult =
  | { ok: true; stats: LineStats }
  | { ok: false; reason: "not-a-repo" | "git-error"; detail: string };

/**
 * The empty tree object, which every git repository has whether or not anything
 * has been committed. Diffing against it is how an unborn repo (no HEAD yet)
 * still reports its staged content as insertions.
 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** True when the repo has no commits yet, so `HEAD` cannot be resolved. */
function hasHead(cwd: string, run: GitRunner): boolean {
  try {
    run(["rev-parse", "--verify", "HEAD"], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lines in a file, for untracked files that `git diff` does not see.
 *
 * Returns 0 for anything unreadable or binary. Under-counting is the right
 * failure here: human-driver's trigger firing late is a mild annoyance, whereas
 * firing on a garbage count would be a false interruption.
 */
function untrackedLineCount(cwd: string, relPath: string): number {
  let buf: Buffer;
  try {
    buf = readFileSync(join(cwd, relPath));
  } catch {
    return 0;
  }
  // A NUL byte in the first 8k is git's own binary heuristic.
  if (buf.subarray(0, 8000).includes(0)) return 0;
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 0x0a) lines++;
  // A trailing newline terminates the last line rather than starting one.
  return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
}

/**
 * Count changed lines across the working tree, including untracked files.
 *
 * Never throws. A failure is reported so the caller can park rather than
 * guessing at a number.
 */
export function changedLineStats(cwd: string, run: GitRunner = defaultRunner): LineStatsResult {
  const base = hasHead(cwd, run) ? "HEAD" : EMPTY_TREE;

  let numstat: string;
  try {
    numstat = run(["diff", base, "--numstat", "-z"], cwd);
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = String(err.stderr ?? err.message ?? "git failed").trim();
    return /not a git repository/i.test(detail)
      ? { ok: false, reason: "not-a-repo", detail }
      : { ok: false, reason: "git-error", detail };
  }

  const paths = new Set<string>();
  let insertions = 0;
  let deletions = 0;

  // `--numstat -z` emits `<add>\t<del>\t<path>\0`, except renames, which emit
  // `<add>\t<del>\t\0<from>\0<to>\0` — the path field is empty and the two
  // paths follow as separate records.
  const parts = numstat.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec === undefined || rec === "") continue;
    const [addRaw, delRaw, ...pathParts] = rec.split("\t");
    if (addRaw === undefined || delRaw === undefined) continue;

    let path = pathParts.join("\t");
    if (path === "") {
      // Rename/copy: consume the two following records, keep the destination.
      i++;
      path = parts[++i] ?? "";
    }
    if (path === "") continue;

    // Binary files report "-" for both counts; charge the file, not the bytes.
    if (addRaw !== "-") insertions += Number(addRaw) || 0;
    if (delRaw !== "-") deletions += Number(delRaw) || 0;
    paths.add(path);
  }

  // Untracked files are invisible to `git diff` but are absolutely changes the
  // human made, so they have to be counted separately.
  let untracked: string;
  try {
    untracked = run(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  } catch {
    // Tracked changes are still a usable measurement; do not fail the whole read.
    untracked = "";
  }
  for (const rel of untracked.split("\0")) {
    if (rel === "") continue;
    paths.add(rel);
    insertions += untrackedLineCount(cwd, rel);
  }

  return { ok: true, stats: { files: paths.size, insertions, deletions } };
}

/**
 * The working tree's diff, for the agent to review against what the human said
 * they did.
 *
 * Untracked files are appended as labelled content blocks rather than real
 * patches: `git diff` cannot see them, and `--no-index` would mean one
 * subprocess per file plus its non-zero exit convention. What matters is that
 * the agent can read the new code, not that the output is `git apply`-able.
 *
 * Returns `null` rather than throwing — a failure here should quietly skip the
 * attachment, never break the human's turn.
 */
export function workingDiffText(cwd: string, run: GitRunner = defaultRunner): string | null {
  const base = hasHead(cwd, run) ? "HEAD" : EMPTY_TREE;

  let diff: string;
  try {
    diff = run(["diff", base], cwd);
  } catch {
    return null;
  }

  let untracked: string;
  try {
    untracked = run(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  } catch {
    untracked = "";
  }

  const parts = diff === "" ? [] : [diff];
  for (const rel of untracked.split("\0")) {
    if (rel === "") continue;
    let content: Buffer;
    try {
      content = readFileSync(join(cwd, rel));
    } catch {
      continue;
    }
    if (content.subarray(0, 8000).includes(0)) {
      parts.push(`--- new binary file: ${rel} (${content.length} bytes)`);
      continue;
    }
    parts.push(`--- new file: ${rel}\n${content.toString("utf8")}`);
  }

  return parts.length === 0 ? "" : parts.join("\n");
}

/** Cheap check used to decide whether git-derived output is available at all. */
export function isGitRepo(cwd: string, run: GitRunner = defaultRunner): boolean {
  try {
    run(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}
