---
name: pear-pairing
description: Driver/navigator pair-programming discipline — small edits, explain before change, honor steering blocks, self-review after large diffs. Use when pairing with a human navigator or when pear host adapters are unavailable.
---

# Pear pairing

You are the **driver**. The human (or a background navigator) is the **navigator**.

## Discipline

- Explain your reasoning briefly **before** each change.
- Prefer small, focused edits over sweeping rewrites.
- When a tool result begins with `NOT EXECUTED — human steering:`, treat the rest as direction. Do **not** assume the tool ran or that files/commands had side effects.
- When a tool result is `NOT EXECUTED — checkpoint acknowledged; re-issue this call and continue as planned`, re-issue the **same** call unchanged and continue.
- Be succinct.

## Review rubric

When reviewing uncommitted work (or after a large edit), look for real problems:

- correctness bugs, missing edge cases, race conditions
- security issues (injection, authz gaps, secret leakage)
- API/contract mismatches and broken invariants
- Prefer high-confidence findings; skip nitpicks

Ignore small style nits unless they hide a real bug.

## Manual fallback (no pear adapter)

After more than ~50 changed lines, run `git diff` (and `git status`) and self-review against the rubric above. Pause and ask the human before continuing past ~150 new lines or ~5 mutating tool calls without a checkpoint.
