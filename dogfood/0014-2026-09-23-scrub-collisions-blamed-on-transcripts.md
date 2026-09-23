# 0014 — a full re-ingest blames 1,135 scrub-caused collisions on the transcripts

| | |
|---|---|
| **Bead** | `asc-o3tn` |
| **Surfaced** | 2026-09-23 |
| **Surfaced by** | `asc ingest claude-code --full --dry-run`, the dry run before `asc-6ola.6` stage 5 |
| **Entry type(s)** | tool_denial, context_compaction, skill_activation, user_correction (derived) |
| **Severity** | P2 |
| **Status** | open |

## What was found

A full re-ingest of this store reports 1,135 collisions: ids that already hold a *different*
entry. It explains every one with the same cause: "Two transcript files reused the same
(session, record) identity for different content." That cause did not happen. Every collided id
is a row the `fc8313f` scrub rewrote. Re-derivation reproduces the real `cwd` and `project`, the
stored row holds the pseudonym, and so the content fingerprint differs. The message asserts a
cause it never checked. And because these 1,135 are counted together with real collisions, any
genuine one is now invisible in that count: an edited transcript, or a rule change that forgot
its derivation version.

## How it surfaced

During `asc-6ola.6` I expected collisions only where the rule had changed, and that type was
already given a new id (`verification_run@2`). They showed up on the four types whose rule had
**not** changed, which contradicted the plan. So I followed one row, and it led to
[0013](0013-2026-09-23-ingest-undoes-the-scrub.md). Nobody was looking for this.

## The metric

The dry-run table, exact:

```
entry   tool_denial         3 new, 44 already present, 540 collided
entry   context_compaction  1 new, 108 already present, 493 collided
entry   verification_run    1161 new
entry   skill_activation    13 already present, 84 collided
entry   user_correction     1 already present, 18 collided
```

The warning, exact:

```
Warning: 1135 derived entries collided with a DIFFERENT entry already recorded
under the same id, and were not written.
...
this id already holds a DIFFERENT entry. Two transcript files reused the same
(session, record) identity for different content, so the second one would be
refused rather than silently dropped.
```

Every collided id, joined to the stored row and tested for a pseudonym (`<user>`, `<project-`,
`<org-`), with a read-only connection:

```
collided_in_store|scrubbed
1135|1135
```

## The pattern

**An error message that names a cause instead of stating an observation.** The code knows two
fingerprints differ. It does not know why, and it says why anyway. The explanation was right
when it was written (`asc-90h`, cross-file key reuse), and it went stale when a second way to
reach the same branch appeared.

## Why nothing else would have caught it

A plain `asc ingest` (with the cursor) skips unchanged files, so it never re-derives a scrubbed
event. Only `--full` does, and nothing had run `--full` against this store since the scrub. The
tests exercise the collision branch with fixtures where the cause really is key reuse, so the
message is correct in every test.

## Consequences and constraints

- Largely resolved by `asc-i2kw`: with the pseudonyms applied at write time, re-derivation would
  reproduce the stored rows and they would be `present`, not `collided`.
- Separately, the message should say *what* differs (which fields), not guess *why*.

## Links

- Bead: `asc-o3tn` (depends on `asc-i2kw`)
- Related: [0013](0013-2026-09-23-ingest-undoes-the-scrub.md), `fc8313f`
