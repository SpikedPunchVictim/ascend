# 0023 — the install-hook consent text said a file it was about to rewrite did not exist yet

| | |
|---|---|
| **Bead** | `asc-tuur.6` (fixed in flight) |
| **Surfaced** | 2026-09-27 |
| **Surfaced by** | the user running `asc install-hook` in this repository to add the PostToolUse stage, and pasting the output |
| **Entry type(s)** | none — installer text |
| **Severity** | P3 |
| **Status** | fixed in the asc-tuur.6 commit |

## What was found

Two sentences the installer prints were false for the install they described:

1. The consent line said it would **rewrite** `.claude/ascend-hook.sh`, then said in the same
   sentence that "this file does not exist yet the first time this runs". Both words came from
   one template; only the verb was conditional.
2. "the hook is inert until .ascend/ exists in <repo>" was printed in a repository that has a
   store. `install-hook` refuses to run without one, so in the installing checkout it is always
   false. The sentence was about a teammate's clone, but it named the installer's own directory.

## How it surfaced

The user upgraded an existing install and pasted the output. **Nobody was looking for it.** The
first-install path, where both sentences are true, is the one the tests exercise, and consent
text prints only on a real terminal, so no test read it.

## The metric

Exact output, pasted by the user. The absolute repository path is redacted to `<repo>`:

```
Warning: ascend will also rewrite
<repo>/.claude/ascend-hook.sh -- unlike
<repo>/.claude/settings.json, which this
command only edits, this file does not exist yet the first time this runs.
...
Warning: the hook is inert until .ascend/ exists in
<repo>, and .ascend/ is gitignored
```

One install: an anecdote.

## The pattern

**A conditional word inside an unconditional sentence.** The sentence was written for one case,
and its variable part was added later without rereading the rest of it.

## Why nothing else would have caught it

Consent is printed only when stdin and stdout are TTYs, so the spawned-binary tests never see it.
The notice is now a pure function (`scriptNotice`) with a test for each branch.

## Links

- Bead: `asc-tuur.6`
