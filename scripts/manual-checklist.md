# Manual checklist

Everything here needs a live model and a real terminal, which is exactly what
`npm test` and `npm run smoke:pi` cannot give you. Run this before shipping a
behavioural change.

Setup:

```sh
cd /some/scratch/git/repo
pi -e /path/to/pear/adapters/pi/extensions/pear.ts
/pear-mode agent-driver
```

**Standing rule: the session must never end because of a card.** If pi exits, or
you cannot type, that is a bug regardless of anything else on this list.

## A. Scoping

1. Give it a vague task ("make the sync more reliable"). It should ask something
   useful via a question card before proposing anything — not guess.
2. The question card offers pre-filled options you would actually pick, plus
   "Something else…".
3. Ask it to edit a file during scoping. It should refuse and explain, without
   erroring.
4. Tell it to run something destructive in bash during scoping (`rm -rf build`).
   Blocked. `git status` and `rg` still work.
5. The plan card is readable: summary first, numbered steps, risks only if real.
6. **Change something…** → it revises and re-proposes. Editing is still closed.
7. **Keep exploring** → it looks harder and re-proposes. Editing is still closed.
8. **Esc** → turn ends, nothing approved, you can type normally.
9. **Looks good** → editing opens and it starts on step 1.

## B. Cadence — the main event

10. Let it work through a real task. Count the checkpoints.
    - Do they land at seams, or mid-thought?
    - Is there ever a wall of changes you cannot hold in your head?
    - More than ~8 in an hour of work → raise `/pear-config`.
    - Fewer than ~2 → lower it.
11. Several small edits to one file should **not** trigger a checkpoint.
12. One large file rewrite should trigger one immediately afterwards.
13. Watch for the in-band nag appearing on tool results before any block.
14. Push past the budget deliberately. The block explains itself, nothing was
    executed, and the agent recovers by checking in and re-issuing.

## C. Checkpoint answers

15. **Keep going** → it proceeds with what it said was next.
16. **Walk me through a file…** → sub-select appears, it explains that file,
    makes no edits, and **the card comes back**. This is the one to watch.
17. During a walkthrough, ask it a follow-up question. It should answer — it is
    not parked.
18. Try to make it edit during a walkthrough. Blocked, with a clear reason.
19. **Change direction…** → your text genuinely supersedes its stated `next`.
20. In the steering editor, press Enter on an empty line. It must stay in the
    editor, not submit nothing.
21. **Stop here** → turn ends, you hold the prompt, session alive. Read-only
    commands still work. It does not sneak in one more fix.
22. After a stop, type anything. Work resumes normally.
23. **Esc** → turn ends, no stop latch, you can just talk. The next checkpoint
    still shows the changes you did not acknowledge.

## D. Summaries

24. Summaries are 1–3 plain sentences, not status reports. No headers, no
    bulleted file lists, no "I have successfully…".
25. Each one is legible against the agreed plan — you can tell which step it is.
26. It says *why*, not only what.

## E. File list truthfulness

27. Stage a change (`git add`) and checkpoint — it still shows.
28. Delete a file and checkpoint — it shows.
29. Have the agent under-report `files`. The git list is what you see first, and
    an uncorroborated claim appears under "also reported by the agent".
30. Run in a non-git directory. The list is marked unverified; the loop still
    works.

## F. Lifecycle

31. Approve a plan, then `/reload`. The plan is picked back up and you stay in
    the building phase.
32. Quit pi while a card is open. It exits cleanly.
33. Ctrl-C during a tool call, then checkpoint. Nothing is lost or double-counted.
34. `/pear-mode off` while a card is open → the card closes, the agent continues
    ungated.
35. `/pear` after a plan is approved → editing closes, scoping resumes.
36. `/pear-checkpoint` while the budget is blown → you get the card and can clear
    it yourself.

## G. Other extensions

37. With another extension's tools active, startup mentions it once.
38. `/pear-exclusive` disables them and persists. pi's own tools and pear's
    remain.
