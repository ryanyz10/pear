# AGENTS.md

## Project overview

`pear` is a pair-programming **loop core** plus thin **host adapters**. The loop gates mutating tool calls with human checkpoints and, in Git repos, runs a background **navigator** that reviews uncommitted changes. Findings are human-only by default.

- Runtime: Node.js **>= 22.19.0** (`.tool-versions` pins the local version).
- Language: TypeScript in native ESM / `NodeNext` mode.
- Package manager: npm; commit `package-lock.json` when dependencies change.
- Execution model: TypeScript is run directly with Node’s type-stripping support; this project does not build emitted JavaScript.
- Primary ship: **pi extension** (`pi install` / `pi -e`). Follow-on adapters: opencode, Claude Code, Cursor.

## Repository layout

- `core/` — host-free loop: git inspection, navigator scheduler, review parse/triage, config thresholds, checkpoint accounting, LLM review seam.
- `adapters/pi/` — pi extension (`extensions/pear.ts`) + testable `runtime.ts`.
- `adapters/opencode/`, `adapters/claude-code/`, `adapters/cursor/` — follow-on host plugins/hooks.
- `adapters/shared/` — conversational block template + navigator daemon kit (Claude Code / Cursor).
- `skills/pear-pairing/` — driver/navigator discipline skill (portable prompt layer).
- `test/` — `node:test` suites for core + pi gate/lifecycle + conversational contracts.
- `scripts/smoke-pi.sh` — pi `-e` and packaged-install smoke.

Core rule: nothing under `core/` imports a host SDK. Adapters import core, never each other (except `adapters/shared/`).

## Setup and common commands

```sh
npm install
npm test
npm run typecheck
npm run smoke:pi
```

Install as a pi package (from this repo):

```sh
pi install "$(git rev-parse --show-toplevel)"
# or: pi -e ./adapters/pi/extensions/pear.ts
```

Focused tests:

```sh
node --experimental-strip-types --test test/checkpoint.test.ts
node --experimental-strip-types --test test/pi-gate.test.ts
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
  import { changedLines } from "../core/git.ts";
  ```
- `tsconfig.json` is strict, uses `NodeNext`, has `erasableSyntaxOnly`, and has `noEmit: true`.
- Prefer standard erasable TypeScript syntax. Do not introduce enums, parameter properties, namespaces, or other syntax incompatible with Node type stripping / `erasableSyntaxOnly`.
- Keep types narrow and explicit at boundaries. Use `unknown` for untrusted data, then validate it before casting or using it.
- Use `import type` for type-only imports, consistent with existing source.
- Follow existing style: double quotes, semicolons, trailing commas in multiline constructs, and compact helpers where they remain readable.
- Use non-null assertions only when an immediately evident local invariant establishes presence; otherwise handle the absent case.
- Keep pure policy/threshold logic in small exported functions where it can be tested without I/O.

## Core invariants

### Checkpoint accounting (`core/checkpoint.ts`)

- Mutation counters are **relative to the last reset**; the mutation baseline is always 0.
- `check` before `reserve`; settle by `toolCallId` (unknown ids no-op).
- Mid-batch reset uses `resetBaseline(null)` → `rebasePending`; `finishRebase` only at the first following `turn_end`, or `abandonRebase` on read failure. Never leave `rebasePending` across turns.
- Contract strings are canonical and cross-host: `STEERING_CONTRACT`, `ACK_CONTRACT`.

### Pi adapter gate

- Mutating tools: `write` / `edit` / `bash`.
- Over budget + UI → always **block** the triggering call (`ACK_CONTRACT` or `STEERING_CONTRACT + text`) and suppress the rest of the batch until `turn_end`.
- Headless (`hasUI=false`) allows without reserving. UI input throw fails open (reset + reserve + allow).
- Git detection via `gitOk(cwd)`, not `stateHash` try/catch. All line reads go through a guarded helper.

### Navigator scheduler (`core/navigate.ts`)

- States: `IDLE`, `PENDING`, `WAITING_INTERVAL`, `REVIEWING`.
- Single in-flight review. Driver turns park scheduling (`setAgentActive`).
- Reviews are debounced, min-size gated, interval-limited, and deduplicated by content-sensitive state hash.
- Scheduler changes are race-prone — add fake-timer tests for every state transition.

### Review protocol

- `REVIEW_SYSTEM` requires a JSON array of findings. Keep schema in `core/review.ts` and the prompt synchronized.
- Parse defensively. Malformed responses become navigator errors, not session crashes.
- Triage: only `small` + `low` findings are filtered.
- Findings are human-only by default on every host.

### Non-git cwd

- Navigator off; mutation-count pacing only.

## Testing guidance

- Tests use `node:test` and `node:assert/strict`.
- Keep tests independent and deterministic. Temp Git repos via `mkdtempSync` + local `git init`.
- Especially cover: unborn repos; staged/unstaged/untracked; binary/unreadable files; checkpoint continue vs steering; concurrent-sibling reservations; deferred rebase / abandon; scheduler races; malformed reviews.
- Pi gate/lifecycle tests use injectable fakes — no pi runtime required.
- When modifying a pure helper, add focused cases in its existing test file.

## Change workflow

1. Read the relevant `core/` or `adapters/` module and its tests.
2. Make the smallest focused change that satisfies the task.
3. Add or update tests with the implementation.
4. Run the focused test file during iteration.
5. Run `npm test` and `npm run typecheck` before completion.
6. For pi packaging changes, run `npm run smoke:pi`.
7. Inspect `git diff --check` and `git diff`.

Avoid unrelated refactors, dependency upgrades, generated artifacts, or changes to runtime defaults unless the task requires them.

## Human collaboration expectations

- State intent briefly before making a change.
- Prefer small, reviewable edits and validate them promptly.
- Respect human steering immediately, including steering received mid-tool invocation.
- Do not claim commands, writes, or tests ran unless their output confirms they did.
- Surface assumptions, validation gaps, and behavior changes clearly in the handoff.
