# 0014 — a full re-ingest blames 1,135 scrub-caused collisions on the transcripts

| | |
|---|---|
| **Bead** | `asc-o3tn` |
| **Surfaced** | 2026-09-23 |
| **Surfaced by** | `asc ingest claude-code --full --dry-run`, the dry run before `asc-6ola.6` stage 5 |
| **Entry type(s)** | tool_denial, context_compaction, skill_activation, user_correction (derived) |
| **Severity** | P2 |
| **Status** | message fixed in the commit that adds **Resolution**; the label split stays open under `asc-o3tn` |

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

- ~~Largely resolved by `asc-i2kw`~~ **Corrected 2026-09-23:** `asc-i2kw` was closed as by design (see
  [0013](0013-2026-09-23-ingest-undoes-the-scrub.md)'s correction), because ingest keeps the label verbatim. The
  scrubbed rows will therefore collide on every `--full` run. They need a read-side alias, tracked in `asc-o3tn`.
- Separately, the message should say *what* differs (which fields), not guess *why*.

## Resolution

The line for each refusal now names the fields that differ, and which of them the stored copy holds
redacted. It no longer names a cause (`packages/cli/src/entry-difference.ts`). The summary counts
collisions that involve a redacted field separately, so a collision with **no** redacted field,
such as an edited transcript or a rule change that forgot its derivation version, can be told
apart from this population.

**The metric.** `asc ingest claude-code --full --dry-run` on the live store, 2026-09-28. Exact
table and summary:

```
entry    tool_denial           7 new, 74 already present, 505 collided
entry    context_compaction    3 new, 222 already present, 453 collided
entry    verification_run      1 new, 1231 already present
entry    skill_activation      118 already present
entry    user_correction       5 already present, 14 collided
entry    review_finding        65 already present, 11 rejected
Warning: 972 derived entries collided with a DIFFERENT entry already recorded under the same id, and were not written -- 972 of them where the stored copy holds a redaction placeholder in a field that differs.
```

The per-line messages, grouped (`uniq -c` over the unwrapped stderr, the text after the field list
cut off):

```
 827 differing in cwd, properties.project. The stored copy holds redaction placeholders in properties.project
 133 differing in cwd, properties.discovered_tools, properties.project. The stored copy holds redaction placeholders in properties.discovered_tools, properties.project
  10 differing in cwd, evidenceText, properties.project. The stored copy holds redaction placeholders in properties.project
   1 differing in cwd, properties.project, properties.tool_name. The stored copy holds redaction placeholders in properties.project, properties.tool_name
   1 differing in cwd, evidenceText, properties.project. The stored copy holds redaction placeholders in evidenceText, properties.project
```

**What the first version of this fix got wrong, and how it was caught.** It flagged a collision
as redaction only when *every* differing field was a filled placeholder. The unit fixtures agreed
with that rule. The live store matched it on **0 of 972**. The reason is `cwd`: every redacted row
stores an absolute path (`/Users/<user>/projects/<project-G>`), and the deriver has written `cwd`
project-relative since `asc-tlc` (`.` for this sample). So `cwd` differs outside its
placeholders. The split of stored derived rows, from `asc query`:

```
type_name           abs_cwd  placeholder  n
context_compaction  0        0            222
context_compaction  1        1            527
tool_denial         0        0            74
tool_denial         1        1            564
user_correction     0        0            5
user_correction     1        1            19
```

Every row with a placeholder has an absolute `cwd`, and no row without one does. Redaction is part
of every one of these differences and the whole of none. So the message now marks redaction per
field instead of claiming it as the cause. The 10 `evidenceText` differences that are not
redaction are not characterised.

This resolves the second consequence above, the message. The first consequence stays open under `asc-o3tn`: one project is stored under two spellings, and that needs a read-side alias. The collided count here is 972 against 1,135 in the metric above, because transcripts deleted since then no longer re-derive.

## Links

- Bead: `asc-o3tn`
- Related: [0013](0013-2026-09-23-ingest-undoes-the-scrub.md), `fc8313f`
