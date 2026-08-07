/**
 * Git working-tree inspection for the checkpoint's "files you changed" list.
 *
 * **This is display-only.** Nothing here feeds the gate: the checkpoint budget
 * is a pure count of mutating tool calls. That bound is what lets this module
 * stay simple — a wrong or missing file list produces a worse-looking
 * checkpoint card, never a wedged or bypassed loop.
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

/** Cheap check used to decide whether git-derived output is available at all. */
export function isGitRepo(cwd: string, run: GitRunner = defaultRunner): boolean {
  try {
    run(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}
