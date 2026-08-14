/**
 * Is a shell command provably read-only?
 *
 * Used for two things, both of which stay usable when the answer is "no":
 * excluding harmless inspection from the checkpoint budget, and letting the
 * agent keep reading code while scoping or after the human has said "stop".
 *
 * **This never decides whether a command runs** — pi does that. A wrong
 * "mutating" answer only costs an earlier checkpoint.
 *
 * ## Two independent gates
 *
 * A command is read-only only if **both** hold:
 *
 *   1. It is syntactically simple: printable ASCII, no expansion, no
 *      redirection, no subshell, no glob, no env-assignment prefix, and no
 *      path-qualified binary.
 *   2. Every command in it matches an entry in the allowlist.
 *
 * "Every command", not "the command": a pipeline or a chain is admitted when
 * each of its segments would be admitted alone. `git log | head` reads exactly
 * what `git log` and `head` read, and refusing it only taught the agent to run
 * the same inspection in two calls. Composition is not what makes a command
 * dangerous — the verbs are, and the allowlist still decides those.
 *
 * Rule 1 is not a policy about which programs are safe — it is what makes rule
 * 2 mean anything. If we cannot say which tokens the shell would run, an
 * allowlist of programs decides nothing. So it stays, and it is not
 * configurable.
 *
 * ## Why `shell-quote`, and what it does not do
 *
 * Tokenizing is `shell-quote`'s `parse`, which is a parser rather than a split
 * on whitespace, so ordinary quoted arguments (`grep "foo bar" file`) are read
 * correctly instead of being refused. Operators come back as objects
 * (`{ op: "|" }`, `{ op: ">" }`, `{ op: "glob" }`, comments), which is what
 * makes the structure visible at all: the four control operators below split
 * the stream into segments, and **every other** non-string element — redirect,
 * background, subshell, glob, comment — still rejects the whole command.
 *
 * Redirection is refused because `>` writes and `<` changes what a segment
 * reads from; globs because the pattern is gone by the time we see it, and
 * `{ op: "glob" }` carries no promise about what it expands to. Both are
 * separate arguments from pipelines, and neither is needed to make inspection
 * composable.
 *
 * **A successful parse is not a safety verdict**, and two cases prove it:
 *
 * - Backticks are not operators. `` cat `rm -rf x` `` parses to the plain
 *   strings `["cat", "`rm", "-rf", "x`"]` — nothing in the result is flagged.
 * - `$` expansion is silent. `echo ${HOME}` parses to `["echo", ""]`: the
 *   interesting part is gone by the time we see it.
 *
 * Both are therefore rejected by a scan of the raw string *before* parsing.
 * The parser is a tokenizer here and nothing more; the judgement stays in this
 * file.
 *
 * Rule 2 **is** the user's policy. The list is a config key
 * (`allowedReadOnlyCommands`), the defaults below are only a starting point,
 * and pear does not second-guess what is in it. Entries are matched as token
 * prefixes: `git status` matches `git status --short`, and `ls` matches
 * `ls -R core`. A shorter entry is a broader permission — `git` alone would
 * allow every git subcommand.
 *
 * There is exactly one thing the list cannot permit: a flag that names a file
 * to write. That is not a judgement about any program, it is the literal
 * definition of the question being asked. `git diff --output=notes.md` would
 * otherwise let the agent create a file during scoping, which is the one thing
 * the gate exists to prevent.
 *
 * `--output` is unambiguous everywhere, so it is refused everywhere. Bare `-o`
 * is not: it means "only matching" to grep, "long without group" to ls, and
 * "or" to find, all of which read. It is therefore refused for `git` alone,
 * where it is the short form of `--output`.
 *
 * ## What the defaults do and don't include
 *
 * Dual-purpose programs are left out, because a flag-by-flag chase never ends:
 * `sort -o`, `uniq <out>`, `tree -o`, `less -o`, `xxd -r`, `hostname -F`,
 * `date -s`, `file -C`, `find -delete/-exec`, `xargs <anything>` and
 * `echo > /dev/…` all write under some argument combination. Likewise
 * `git branch`, which deletes and renames under `-d`/`-D`/`-m`.
 *
 * `git diff`, `git show` and patch-rendering `git log` **are** included, which
 * is a deliberate change of position. They can invoke a pager, an external diff
 * driver, or a textconv filter, all of which execute programs named in git
 * config. That risk is accepted: reading the diff is most of what inspection
 * is *for*, and the configuration that would exploit it lives in the very
 * repository whose test suite the agent already runs. Anyone who disagrees can
 * take them out of the list.
 */

import { parse } from "shell-quote";

/**
 * The starting list. Entries are token prefixes; see the header for why
 * dual-purpose programs are absent.
 */
export const DEFAULT_READ_ONLY_COMMANDS: readonly string[] = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "which",
  "whoami",
  "basename",
  "dirname",
  "realpath",
  "true",
  "false",
  "uname",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git rev-parse",
  "git ls-files",
];

/**
 * Expansion the tokenizer will not flag for us. See the header: `$` disappears
 * into an empty string and backticks are not treated as operators at all, so
 * neither can be caught after parsing.
 */
const EXPANSION_CHARS = /[$`]/;

/** `FOO=bar cmd` — an env prefix can alter what `cmd` even resolves to. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Does this command name a file to write? Rejected for every entry in every
 * list. See the header: this is the definition of the question, not a policy,
 * and why bare `-o` is only read as an output flag for git.
 */
function namesAnOutputFile(tokens: string[]): boolean {
  const short = tokens[0] === "git";
  return tokens.some(
    (t) => t === "--output" || t.startsWith("--output=") || (short && t === "-o"),
  );
}

/**
 * Does this command tell ripgrep to execute a program? `rg --pre <cmd>` runs
 * an arbitrary preprocessor over every file searched, which makes "read-only"
 * meaningless whatever the allowlist says. Like `--output`, this is the
 * definition of the question rather than a policy: a command that executes a
 * program of the caller's choosing cannot be vouched for by this file.
 * (`--pre-glob` alone is harmless — it only filters which files `--pre`
 * applies to — so it is not matched here.)
 */
function namesAPreprocessor(tokens: string[]): boolean {
  if (tokens[0] !== "rg") return false;
  return tokens.some((t) => t === "--pre" || t.startsWith("--pre="));
}

/**
 * The operators that separate one command from the next without changing what
 * either of them does. Anything else structural is refused; see the header.
 */
const SEGMENT_OPERATORS = new Set(["|", "&&", "||", ";"]);

/** Is this parsed element one of the operators we split on? */
function isSegmentOperator(el: unknown): boolean {
  if (typeof el !== "object" || el === null) return false;
  const op = (el as { op?: unknown }).op;
  return typeof op === "string" && SEGMENT_OPERATORS.has(op);
}

/**
 * The commands the shell would run, in order, or `undefined` if the string
 * contains anything we decline to reason about.
 *
 * A segment that comes back empty (`ls |`, `; ls`, `a && && b`) is a syntax we
 * cannot price, so it fails with the rest rather than being skipped.
 */
function tokenizeSegments(command: string): string[][] | undefined {
  let parsed: unknown[];
  try {
    parsed = parse(command) as unknown[];
  } catch {
    // A command this parser cannot read is not one we will vouch for.
    return undefined;
  }

  const segments: string[][] = [];
  let current: string[] = [];
  for (const el of parsed) {
    if (typeof el === "string") {
      // `parse` yields "" where an expansion used to be; the raw-string scan
      // has already refused those, so this is only tidying.
      if (el !== "") current.push(el);
      continue;
    }
    if (!isSegmentOperator(el)) return undefined;
    segments.push(current);
    current = [];
  }
  segments.push(current);

  if (segments.some((s) => s.length === 0)) return undefined;
  return segments;
}

/** Entries are written by hand, so they are split the simple way. */
function entryTokens(entry: string): string[] {
  return entry.trim().split(" ").filter((t) => t !== "");
}

/**
 * Does `tokens` begin with every token of `entry`?
 *
 * Prefix matching rather than equality is what lets one scheme cover both bare
 * verbs and subcommands: `ls` permits its flags, `git status` permits its own
 * without permitting `git push`.
 */
function matchesEntry(tokens: string[], entry: string): boolean {
  const wanted = entryTokens(entry);
  if (wanted.length === 0 || wanted.length > tokens.length) return false;
  return wanted.every((t, i) => tokens[i] === t);
}

/** Would this one command, on its own, be admitted? */
function isReadOnlySegment(tokens: string[], allowed: readonly string[]): boolean {
  const verb = tokens[0] ?? "";

  // An env-assignment prefix, or a path-qualified binary we cannot vouch for.
  if (ENV_ASSIGNMENT.test(verb)) return false;
  if (verb.includes("/")) return false;

  if (namesAnOutputFile(tokens)) return false;
  if (namesAPreprocessor(tokens)) return false;

  return allowed.some((entry) => matchesEntry(tokens, entry));
}

export function isReadOnlyBashCommand(
  command: string,
  allowed: readonly string[] = DEFAULT_READ_ONLY_COMMANDS,
): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;

  // Anything outside printable ASCII (incl. unicode whitespace lookalikes)
  // is not something we will reason about.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }

  if (EXPANSION_CHARS.test(trimmed)) return false;

  const segments = tokenizeSegments(trimmed);
  if (segments === undefined || segments.length === 0) return false;

  // Every segment, because the weakest link is the one that writes.
  return segments.every((tokens) => isReadOnlySegment(tokens, allowed));
}
