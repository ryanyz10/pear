# pi extension API — verified notes

Verification target: `@earendil-works/pi-coding-agent` **0.83.0** (exact pin; see
`package.json`). Everything below was read from the shipped type definitions in
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
(and `@earendil-works/pi-agent-core/dist/types.d.ts` for tool result types), not
from prose documentation alone. Line numbers are from the 0.83.0 `.d.ts` files.

Re-run this checklist whenever the pinned version changes. `npm run typecheck`
is the compile gate; `npm run smoke:pi` is the integration gate.

## Tool registration and execution

`ToolDefinition` (types.d.ts:343) — verified fields used by pear:

```ts
execute(
  toolCallId: string,
  params: Static<TParams>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ctx: ExtensionContext,          // full context, NOT a narrowed Pick
): Promise<AgentToolResult<TDetails>>
```

- **`ctx` is the full `ExtensionContext`** (types.d.ts:371), so `ctx.ui.custom`
  is available inside `execute`. (The narrowed
  `ui: Pick<…, "select" | "confirm" | "input" | "notify">` at types.d.ts:399
  belongs to `ProjectTrustContext`, a different type — do not confuse them.)
- **`signal: AbortSignal | undefined`** is passed to `execute`; pear uses it to
  resolve a pending checkpoint card as `cancelled`.
- **`executionMode?: "sequential" | "parallel"`** (types.d.ts:369). Documented
  meaning of `"sequential"`: *"this tool must execute one at a time with other
  tool calls."* This is stronger than same-response ordering and is the
  mechanism pear relies on to avoid capturing a git baseline while a sibling
  mutation is mid-write. It is a best-effort mitigation, not a correctness
  requirement: late settles are handled by exactly-once accounting.
- **No `unregisterTool` exists** on `ExtensionAPI`. Consequence: `pear_checkpoint`
  stays registered in `off` mode and must return a benign no-op result.

### `AgentToolResult` (pi-agent-core types.d.ts:310)

```ts
{
  content: (TextContent | ImageContent)[];
  details: T;
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

- **`terminate?: boolean`** — *"Hint that the agent should stop after the current
  tool batch. Early termination only happens when every finalized tool result in
  the batch sets this to true."*

  This gives pear a **runtime-enforced Stop**: the checkpoint tool returns
  `terminate: true` on the Stop outcome, ending the agent's work loop without
  killing the session. Because termination requires *every* result in the batch
  to set it, a batch mixing `pear_checkpoint` with other tools will not
  terminate — so the stop latch remains the guaranteed backstop and
  `terminate` is defense in depth, not the sole mechanism.

- **Error signalling:** returning a value never sets the error flag. To mark a
  failure you must `throw` from `execute`; pi catches it, reports it to the LLM
  with `isError: true`, and continues (docs/extensions.md "Signaling errors" and
  "Error Handling"). pear does **not** depend on this for control flow: internal
  checkpoint failures return a normal result carrying explicit guidance, so the
  model always receives actionable text.

## Context

`ExtensionContext` (types.d.ts:209):

| Field | Verified meaning |
| --- | --- |
| `ui: ExtensionUIContext` | Full UI surface (types.d.ts:68) |
| `mode: ExtensionMode` | `"tui" \| "rpc" \| "json" \| "print"` (types.d.ts:208). Comment: *"Use `\"tui\"` to guard terminal-only UI such as custom components."* |
| `hasUI: boolean` | *"Whether dialog-capable UI is available (**true in TUI and RPC modes**)"* |
| `signal: AbortSignal \| undefined` | Undefined when not streaming |
| `abort()` | **Never called by pear** — see below |

**Critical distinction:** `hasUI` is true in **both** TUI and RPC. `ui.custom` is
TUI-only. Gating the checkpoint card on `hasUI` would let an RPC session pass
the check while `ui.custom` no-ops. pear therefore tiers on `ctx.mode`:

| `ctx.mode` | Checkpoint UI |
| --- | --- |
| `"tui"` | Full `ui.custom` card |
| `"rpc"` | `ui.select` / `ui.input` dialogs (dialog-capable per `hasUI`) |
| `"json"`, `"print"` | Fail closed — agent-driver degrades to `off` for the session |

### `ctx.abort()` is forbidden in pear

`abort()` aborts the entire agent run. The previous implementation called it
from the `tool_call` handler when blocking, which meant the block `reason`
never reached the model as a tool result — this is the root cause of the
"checkpoint terminates the session early" bug. Blocking is expressed **only**
via the return value (below). There must be zero `ctx.abort()` call sites in
pear.

## Events used by pear

All confirmed present on `ExtensionAPI` (types.d.ts:855+).

| Event | Verified shape / semantics |
| --- | --- |
| `tool_call` | `{ toolCallId, toolName, input }`; returns `ToolCallEventResult { block?: boolean; reason?: string }` (types.d.ts:778). `input` is mutable; later handlers see earlier mutations. |
| `tool_result` | `{ toolCallId, toolName, input, content, isError, usage?, details }` (types.d.ts:692). **`isError` is a real field** — settlement does not rely on inference. |
| `input` | `{ text, images?, source, streamingBehavior? }` (types.d.ts:628). |
| `agent_start` | `{}` — fired when an agent loop starts. |
| `agent_end` | `{ messages }` — **not terminal.** |
| `agent_settled` | *"Fired after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run."* (types.d.ts:546) — **this is the terminal boundary.** |
| `before_agent_start` | Returns `{ systemPrompt?: string }`; *"Replace the system prompt for this turn. If multiple extensions return this, they are chained."* (types.d.ts:800) |
| `session_start` / `session_shutdown` | Shutdown carries `reason: "quit" \| "reload" \| "new" \| "resume" \| "fork"` (types.d.ts:463). |

### `InputEvent.source` resolves the latch-clearing question

```ts
export type InputSource = "interactive" | "rpc" | "extension";
```

The stop latch must be cleared only by genuine user input. Because `source`
distinguishes `"extension"` (i.e. `pi.sendUserMessage`) from `"interactive"` /
`"rpc"`, pear clears the latch **only** when `source !== "extension"`. No probe
was needed; the type makes this decidable. pear itself never calls
`sendUserMessage`, but a third-party extension cannot silently defeat Stop.

### `session_shutdown` covers extension reload

`reason` includes `"reload"`, so a hot reload / session replacement fires the
same event. Hooking `session_shutdown` is therefore sufficient to resolve a
pending checkpoint card and avoid leaked promises — no separate disposal hook
is required.

### Terminal boundary for the stale sweep

`agent_end` may be followed by automatic retry, auto-compaction, or a queued
continuation. Anything that must run exactly once per settled run — the pending
→ stale sweep and the "N uncheckpointed changes" notice — hangs off
`agent_settled`, never `agent_end`.

## Ordering

Documented tool lifecycle (docs/extensions.md:300-308, :751-757):

```
tool_execution_start → tool_call (can block) → execute → tool_result → tool_execution_end
```

- Before `tool_call` runs, pi drains previously emitted agent events, so
  `ctx.sessionManager` is current through the assistant tool-calling message.
- In default parallel mode, **sibling tool calls from one assistant message are
  preflighted sequentially, then executed concurrently.** Preflight
  serialization is why pear's gate accounting needs no locking; concurrent
  *execution* is why settlement must be exactly-once and why late settles after
  a reset must no-op.
- Aborted calls are not guaranteed to emit `tool_result`. pear does not assume
  they do: unsettled entries stay counted and are swept to an explicit `stale`
  state at `agent_settled` — never silently promoted to "confirmed success".

## Tool-call identity

`tool_call` and `tool_result` both carry `toolCallId: string`, and it is the
only correlation handle available on the result. The type system does not
guarantee session-wide uniqueness. pear therefore **fails closed on reuse**: if
`admit` observes an id that already has an active entry, the prior entry is
settled as confirmed (conservative — it counts toward the next checkpoint)
before the new entry is admitted. Correlation never depends on an unproven
uniqueness guarantee.

## git plumbing (used by `core/git.ts`)

`git status --porcelain=v2 -z` verified on a scratch repo:

```
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>     # tracked change
2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>   # rename/copy
u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>                # unmerged
? <path>                                                              # untracked
```

- `hI` (index OID) **is** present on `1`/`2` records — index-only staged changes
  are distinguishable, as required.
- Deletions carry an all-zero index OID
  (`1 D. … <headOID> 0000000000000000000000000000000000000000 a.txt`), so an
  explicit absent-object sentinel is required rather than assuming a real OID.
- **`?` untracked records carry no OIDs at all**, so untracked entries need
  their own token form.
- `-z` makes records NUL-delimited, which is what makes unusual path bytes
  parseable. Note the honest limitation: paths are decoded to JS strings once
  and both baseline and current captures use the same decoding, so diffs stay
  self-consistent, but non-UTF-8 names may render lossily.

## Packaging findings

- `@earendil-works/pi-agent-core` (which defines `AgentToolResult`) is **not** a
  top-level install; it resolves from
  `node_modules/@earendil-works/pi-coding-agent/node_modules/`. pear must not
  import it directly — use the re-exports from `@earendil-works/pi-coding-agent`
  (`export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode }`,
  types.d.ts:33).
- `typebox` (needed for `ToolDefinition.parameters`) resolves at top level only
  as a **hoisted transitive dependency** of pi-coding-agent (1.3.7). Relying on
  hoisting is fragile and defeats exact pinning, so pear declares
  `typebox` explicitly at the same exact version.

## Verification harness

`probe/probe.ts` is a standalone throwaway extension that records the real event
sequence to JSONL. It deliberately does not import anything from `core/` or
`adapters/`, so it can gate the rewrite before deletion and re-confirm behaviour
after wiring.

```sh
pi -e ./probe/probe.ts          # then drive the session; /probe-dump for the log path
```

It exercises: tool lifecycle ordering and id correlation, a blocked call that
uses **no** `ctx.abort()`, a tool that awaits the human inside `execute`,
abort/shutdown resolution, `terminate: true`, `input.source`, and
`agent_end` vs `agent_settled`.

Status: the probe **compiles against the pinned 0.83.0 types** and is included in
`npm run typecheck`, which mechanically verifies every signature claimed above.

## Assumptions deliberately NOT relied upon

- That aborted tool calls emit `tool_result`.
- That `toolCallId` is unique for the session lifetime.
- That `executionMode: "sequential"` fully excludes concurrent siblings.
- That thrown `execute` errors are the only way the model learns of a failure.
- That `hasUI` implies `ui.custom` works.

Each is handled by a conservative fallback rather than an assumption.

## Verified for v3 (still 0.83.0)

### `tool_result` can rewrite what the model sees

`types.d.ts:790`:

```ts
export interface ToolResultEventResult {
    content?: (TextContent | ImageContent)[];
    details?: unknown;
    isError?: boolean;
    usage?: Usage;
}
```

This is how the in-band budget nag is delivered: no extra turn, and it is
attached to the thing the model just did.

**`content` REPLACES, it does not append.** The handler must return
`[...event.content, note]`. Returning only the note silently discards the tool's
real output. `test/pi-lifecycle.test.ts` asserts the original blocks survive
byte-identically.

### Built-in mutating tool input shapes

Used by `core/load.ts` to price a call from its input at `tool_call` time,
without git and without an `await`.

```ts
// dist/core/tools/edit.d.ts:10
declare const editSchema: Type.TObject<{
    path: Type.TString;
    edits: Type.TArray<Type.TObject<{ oldText: Type.TString; newText: Type.TString }>>;
}>;

// dist/core/tools/write.d.ts:4
declare const writeSchema: Type.TObject<{ path: Type.TString; content: Type.TString }>;
```

`EditToolDetails` carries `{ diff, patch, firstChangedLine? }` and `write` has
`details: undefined`, so *results* are not a usable pricing source for both
tools. Inputs are, and they are available before the call runs — which is when
the gate needs them.

### `SourceInfo` does not identify built-ins

`dist/core/source-info.d.ts`:

```ts
export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";
export interface SourceInfo { path: string; source: string; scope: SourceScope; origin: SourceOrigin; baseDir?: string }
```

`ToolInfo` carries `sourceInfo`, but nothing in it separates a pi built-in from a
third-party extension's tool. `exclusive` therefore filters by the known built-in
**names** and uses `SourceInfo` only for display.

### Session state round-trip

`pi.appendEntry(customType, data)` persists without entering the LLM context;
`ctx.sessionManager.getEntries()` replays it. `CustomEntry` is
`{ type: "custom"; customType: string; data?: T }`
(`dist/core/session-manager.d.ts:69`). `data` is whatever was written, so it must
be validated on the way back in — pear ignores a plan entry that does not
type-check rather than trusting it.

### `ui.notify` is not rendered in `print` mode

Notifications are best-effort UI. A `pi -p "/pear-status"` invocation writes
nothing to stdout, so smoke tests must assert on observable state (the config
file) rather than notification text.

## Assumptions deliberately NOT relied upon (v3 additions)

- That `setActiveTools` is pear's alone to call. Scoping records the names it
  removed and adds exactly those back, rather than restoring a snapshot.
- That `SourceInfo` can classify a tool's provenance.
- That a persisted session entry still matches the current schema.

### A mid-run `setActiveTools` must be additive

`extensions.md` § "Dynamic Tool Loading" (~:2306):

> A tool can then add more tools with `pi.setActiveTools()` during execution. Pi
> detects purely additive changes, records the newly available tool names on that
> tool result, and applies the updated active set before the next model request.
> […] The change must be additive: do not remove currently active tools in the
> same call.

This is load-bearing for the plan phase. `pear_plan` approval restores `edit`
and `write` from inside `execute`, mid-run — supported *only* because the call
starts from the live active list and appends. Removing anything in that same
call would forfeit the detection, and the model could be told "editing is open"
while the tools it needs are absent for the rest of the run.

Returning `addedToolNames` by hand is unnecessary: pi derives it from the
active-set change. `test/pi-lifecycle.test.ts` asserts the restore call drops
nothing.

Removals (entering scoping, `exclusive`) happen at `session_start` or in command
handlers, not during tool execution, so the additive rule does not bind them.
