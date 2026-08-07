/**
 * Is a shell command provably read-only?
 *
 * Used for two things, both of which stay usable when the answer is "no":
 * excluding harmless inspection from the checkpoint budget, and letting the
 * human keep reading code after saying "stop".
 *
 * **This never decides whether a command runs** — pi does that. A wrong
 * "mutating" answer only costs an earlier checkpoint.
 *
 * The rule is deliberately *reject-unless-trivially-simple* rather than
 * "parse the shell". Real shell syntax is far too rich to classify safely by
 * inspection: substitutions, subshells, heredocs, process substitution,
 * env-assignment prefixes, aliases, and quoting all create ways for a
 * mutating command to hide inside something that looks read-only. So instead
 * of trying to understand those constructs, we refuse to classify any command
 * that contains them.
 *
 * A command is read-only only if **both** hold:
 *
 *   1. It is syntactically trivial: printable ASCII, no shell metacharacters,
 *      no quotes or backslashes, single command, no redirection.
 *   2. Its verb (and for `git`, its subcommand and flags) is on an allowlist of
 *      programs with no write-capable form under *any* argument.
 *
 * Rule 2 is stricter than it first appears. Dual-purpose programs are excluded
 * entirely rather than flag-by-flag, because that chase never ends:
 * `sort -o`, `uniq <out>`, `tree -o`, `less -o`, `xxd -r`, `hostname -F`,
 * `date -s`, `file -C`, `find -delete/-exec`, `xargs <anything>`, and
 * `echo > /dev/…` all write under some argument combination.
 *
 * `git` deserves specific mention: `git diff`, `git show`, and `git log -p`
 * can invoke a pager, an external diff driver, or a textconv filter — all of
 * which execute arbitrary configured programs. They are therefore treated as
 * mutating. `git status` and non-patch `git log` are allowed.
 */

/** Programs that cannot write, delete, or execute anything under any argument. */
const READ_ONLY_VERBS = new Set([
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
]);

/** git subcommands with no write-capable form, given the flag rules below. */
const GIT_READ_ONLY_SUBCOMMANDS = new Set(["status", "log", "rev-parse", "ls-files", "branch"]);

/**
 * Flags rejected for otherwise-read-only git subcommands.
 *
 * - `-c`/`--config-env` inject arbitrary config, including `core.pager` and
 *   `diff.external`, i.e. arbitrary program execution.
 * - `-o`/`--output` writes to a file.
 * - `-p`/`--patch` renders diffs, which can invoke textconv/external diff.
 * - `--exec`/`--upload-pack`/`--receive-pack` execute programs.
 * - Any `--format`/`--pretty` can embed `%(...)`-style expansions we do not
 *   want to reason about.
 * - `-d`/`-D`/`-m`/`-M`/`--delete`/`--move` make `git branch` destructive.
 */
function hasDisallowedGitFlag(tokens: string[]): boolean {
  for (const token of tokens) {
    if (!token.startsWith("-")) continue;
    const name = token.split("=")[0] ?? token;
    if (
      name === "-c" ||
      name === "--config-env" ||
      name === "-o" ||
      name === "--output" ||
      name === "-p" ||
      name === "--patch" ||
      name === "-d" ||
      name === "-D" ||
      name === "-m" ||
      name === "-M" ||
      name === "--delete" ||
      name === "--move" ||
      name === "--format" ||
      name === "--pretty" ||
      name.startsWith("--exec") ||
      name === "--upload-pack" ||
      name === "--receive-pack"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Characters that make a command untrustworthy to classify by inspection.
 *
 * Includes quotes and backslashes: without them we can split on whitespace and
 * know the result matches what the shell would do. With them we cannot, and a
 * misread token is exactly how a mutation would slip through.
 */
const UNSAFE_CHARS = /[;&|<>$`(){}[\]*?!#~'"\\\n\r\t]/;

/** `FOO=bar cmd` — an env prefix can alter what `cmd` even resolves to. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;

  // Anything outside printable ASCII (incl. unicode whitespace lookalikes)
  // is not something we will reason about.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }

  if (UNSAFE_CHARS.test(trimmed)) return false;

  const tokens = trimmed.split(" ").filter((t) => t !== "");
  if (tokens.length === 0) return false;

  const verb = tokens[0] ?? "";

  // An env-assignment prefix, or a path-qualified binary we cannot vouch for.
  if (ENV_ASSIGNMENT.test(verb)) return false;
  if (verb.includes("/")) return false;

  if (verb === "git") {
    const subcommand = tokens[1] ?? "";
    if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
    return !hasDisallowedGitFlag(tokens.slice(1));
  }

  return READ_ONLY_VERBS.has(verb);
}
