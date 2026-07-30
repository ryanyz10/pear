# AGENTS.md

## Project overview

`pear` is a lean pair-programming CLI. It runs a coding **driver** agent and, for Git repositories, asynchronously runs a **navigator** agent that reviews uncommitted changes.

- Runtime: Node.js **>= 22.19.0** (`.tool-versions` pins the local version).
- Language: TypeScript in native ESM / `NodeNext` mode.
- Package manager: npm; commit `package-lock.json` when dependencies change.
- Execution model: TypeScript is run directly with Node’s type-stripping support; this project does not build emitted JavaScript.

## Repository layout

- `bin/pear` — executable shell shim. Validates Node version and chooses the required type-stripping flag for Node 22–23.
- `src/cli.ts` — command-line parsing and configuration assembly.
- `src/config.ts` — configuration types, defaults, and pure threshold/model parsing helpers.
- `src/drive.ts` — coding-driver agent setup and streamed terminal output.
- `src/tools.ts` — agent file/shell tools and the human checkpoint gate.
- `src/git.ts` — Git working-tree inspection, line counting, hashing, and diff generation.
- `src/navigate.ts` — navigator review scheduler/state machine.
- `src/review.ts` — navigator response schema parsing, triage, formatting, and review prompt.
- `src/session.ts` — interactive session lifecycle, model registry, UI wiring, polling, and driver/navigator coordination.
- `src/ui.ts` — `pi-tui` interactive UI: task editor, streamed agent output, queued findings, checkpoint overlay, and shutdown/input handling.
- `src/theme.ts` — ANSI-based themes for the editor, Markdown output, and checkpoint select list.
- `test/*.test.ts` — unit tests using Node’s built-in `node:test` runner; `ui.test.ts` covers UI behavior with a test terminal.

## Setup and common commands

```sh
npm install
npm test
npm run typecheck
npm start -- --help
# equivalent direct CLI invocation:
./bin/pear --help
```

Run focused tests while iterating:

```sh
node --experimental-strip-types --test test/git.test.ts
node --experimental-strip-types --test test/navigate.test.ts
```

Run both validation commands before handing off a meaningful change:

```sh
npm test && npm run typecheck
```

There is no configured formatter or linter. Preserve the surrounding file’s formatting and use TypeScript’s type checker as the primary static validation.

## TypeScript conventions

- Keep source and tests as `.ts`; use explicit `.ts` extensions for local ESM imports:
  ```ts
  import { changedLines } from "./git.ts";
  ```
- `tsconfig.json` is strict, uses `NodeNext`, has `erasableSyntaxOnly`, and has `noEmit: true`.
- Prefer standard erasable TypeScript syntax. Do not introduce enums, parameter properties, namespaces, or other syntax incompatible with Node type stripping / `erasableSyntaxOnly`.
- Keep types narrow and explicit at boundaries. Use `unknown` for untrusted data, then validate it before casting or using it.
- Use `import type` for type-only imports, consistent with existing source.
- Follow existing style: double quotes, semicolons, trailing commas in multiline constructs, and compact helpers where they remain readable.
- Use non-null assertions only when an immediately evident local invariant establishes presence; otherwise handle the absent case.
- Keep pure policy/threshold logic in small exported functions where it can be tested without I/O.

## Architecture and behavior constraints

### CLI and configuration

- Keep CLI options and help text synchronized in `src/cli.ts`.
- Validate user-facing numeric options before constructing `Config`; errors should explain the bad option and expected value.
- Model specs are `provider/id`; use `parseModel` and `resolveModel` rather than duplicating parsing or registry lookup.
- Preserve the behavior that navigator review is always disabled outside a Git working tree; the CLI warns and uses mutation-count checkpoint pacing there. `--no-nav` explicitly disables it in Git repositories too.

### Git helpers

- The current Git baseline is `HEAD`; for unborn repositories use `EMPTY_TREE`.
- Account for both tracked and untracked changes. `changedLines`, `diffText`, `stateHash`, and `changedFiles` intentionally include untracked files.
- Treat filenames as arbitrary data where possible. Existing NUL-delimited Git parsing handles paths more safely than line-oriented output.
- Do not remove binary detection, diff truncation, or read-error handling without a tested replacement. They bound model input and keep the CLI robust on unusual working trees.
- Prefer `spawnSync`/`execFileSync` argument arrays for Git invocations rather than shell-concatenated commands.

### Driver tools and checkpoints

- `createTools` is the policy boundary for agent-initiated filesystem and shell mutation.
- Before each potentially mutating `write`, `edit`, or `bash`, preserve checkpoint gating via `gate`.
- A tool result beginning with `NOT EXECUTED — human steering:` means the human redirected the action. It is direction, not a successful tool execution; do not assume any file or command side effect occurred.
- Mutation count is deliberately used even for shell commands and non-Git directories. Keep checkpoint pacing conservative.
- Keep file paths resolved relative to the requested project `cwd`; do not silently change process-wide working directory assumptions.

### Navigator scheduler

- `src/navigate.ts` is a state machine with `IDLE`, `PENDING`, `WAITING_INTERVAL`, and `REVIEWING` states.
- Maintain the single-in-flight-review invariant. A new hash while `REVIEWING` must not launch a concurrent review.
- Navigator reviews are debounced, minimum-size gated, interval-limited, and deduplicated by content-sensitive state hash.
- Driver turns park navigator scheduling. A completed review while parked must not schedule another review until normal resume logic decides to do so.
- Scheduler changes are race-prone. Add or update deterministic fake-timer tests for every state transition, retry behavior, deduplication rule, or driver-parking change.

### Review protocol

- `REVIEW_SYSTEM` requires a JSON array of findings. Keep the response schema in `src/review.ts` and the prompt synchronized.
- Parse model output defensively. A malformed response should become a navigator error, not crash the interactive session.
- Preserve triage semantics unless intentionally changing product behavior: only `small` + `low` findings are filtered.

## Testing guidance

- Tests use `node:test` and `node:assert/strict`; do not add a test framework without a compelling reason.
- Keep tests independent and deterministic. Tests needing a repository should create a temporary directory with `mkdtempSync`, initialize/configure Git locally, and remove it in cleanup.
- Test externally observable behavior and edge cases, especially:
  - unborn Git repositories;
  - staged, unstaged, and untracked changes;
  - binary/unreadable files and diff size bounds;
  - checkpoint continuation versus human steering;
  - scheduler timing, races, review failures, and hash reversion;
  - malformed review responses and finding triage.
- When modifying a pure helper, add focused table-like cases in its existing test file. When modifying orchestration, test the full state transition or interaction rather than implementation details alone.

## Change workflow

1. Read the relevant source module and its colocated conceptual test file under `test/`.
2. Make the smallest focused change that satisfies the task.
3. Add or update tests with the implementation, particularly for changed edge cases.
4. Run the focused test file during iteration.
5. Run `npm test` and `npm run typecheck` before completion.
6. Inspect `git diff --check` and `git diff` to catch whitespace problems and unintended edits.

Avoid unrelated refactors, dependency upgrades, generated artifacts, or changes to runtime defaults unless the task requires them.

## Human collaboration expectations

This repository implements a driver/navigator workflow and should be changed with the same discipline:

- State intent briefly before making a change.
- Prefer small, reviewable edits and validate them promptly.
- Respect human steering immediately, including steering received mid-tool invocation.
- Do not claim commands, writes, or tests ran unless their output confirms they did.
- Surface assumptions, validation gaps, and behavior changes clearly in the handoff.
