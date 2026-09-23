# 0013 — every ingest since the scrub has written the real identity back

| | |
|---|---|
| **Bead** | `asc-i2kw` |
| **Surfaced** | 2026-09-23 |
| **Surfaced by** | the dry run before `asc-6ola.6` stage 5 (`asc ingest claude-code --full --dry-run`), then a read-only count of the store |
| **Entry type(s)** | all five derived types (derived) |
| **Severity** | P1 |
| **Status** | open |

## What was found

The store scrub of `fc8313f` (2026-09-18) rewrote machine and project identity to pseudonyms
(`<user>`, `<project-A>`..) in place, **once**. Nothing applies it when an entry is written, so
every ingest since has written the real identity back. All 316 derived entries recorded after
the scrub carry the real username. The scrub's goal, a store without identity at rest, has been
failing quietly since the day after it landed. This is an **absence**: no write-time step exists.

## How it surfaced

`asc-6ola.6` stage 5 was going to re-ingest the whole corpus with `--full` so that
`verification_run` v2 entries could supersede v1. The dry run reported collisions on the four
types whose rule had **not** changed (see [0014](0014-2026-09-23-scrub-collisions-blamed-on-transcripts.md)).
Reading one collided row showed `cwd = /Users/<user>/projects/<project-G>`, which a hex dump
confirmed is stored as literal bytes and is not a display redaction. That led back to
`fc8313f`. The next question was what the rows written *after* the scrub hold.

Nobody was looking for this. The question in hand was a verdict rule for test runs.

## The metric

Rows written after the scrub (`fc8313f` is 2026-09-18 00:12 -0700, 07:12Z), and how many of them
carry the real username. The query ran with the real name. It is shown here with the pseudonym,
and the output is exact:

```
$ sqlite3 .ascend/ascend.db "select type_name, sum(recorded_at > '2026-09-18T07:13'),
    sum(recorded_at > '2026-09-18T07:13' and (cwd like '%<user>%' or properties_json like '%<user>%'))
    from entries where source='derived:claude-code' group by type_name"
context_compaction|108|108
skill_activation|13|13
tool_denial|44|44
user_correction|1|1
verification_run|150|150
```

The rows the scrub itself rewrote:

```
$ sqlite3 .ascend/ascend.db "select count(*), min(recorded_at), max(recorded_at) from entries
    where source='derived:claude-code' and (cwd like '%<user>%' or properties_json like '%<user>%')"
1700|2026-09-17T22:37:40.736Z|2026-09-17T22:37:40.736Z
```

What stage 5 would have added: `entry verification_run 1161 new` (dry-run table, exact). Many
of those would sit beside a v1 row that holds the pseudonym, as a real-identity copy of the
same event.

Only the username was counted. The scrub also covered project names, `mcp__<server>__` names
and a skill name, and those surfaces were not re-measured. 316 is a floor for "re-identified
rows", not a total.

## The pattern

**A one-time repair of data that a live writer keeps producing.** The scrub fixed the rows that
existed and left the writer unchanged. It is the same shape as redaction at the document
boundary, which [0004](0004-2026-09-18-the-corpus-records-identity.md) named: a repair applied
downstream of the process that creates the problem goes stale with that process's next run.

## Why nothing else would have caught it

`fc8313f` verified its own result carefully: identical fingerprints, cardinality kept, EV-19
reproduced. All of that verifies the rows at the moment of the scrub. No check asserts the
invariant *afterwards*, and the store is gitignored, so no diff ever shows it. A test that
ingests a fixture and asserts that no private token appears in the store would catch this. It
cannot exist until a write-time step does.

## Consequences and constraints

- **Entries are immutable.** The 316 are not a cleanup task, and re-running the scrub means
  dropping the immutability trigger again. The fix is prevention at write time: apply the
  pseudonym map before `recordEntry`.
- The map is currently implicit in `fc8313f`. It has to become a durable input, and it has to
  stay out of git, because the map *is* the identity.
- `asc-6ola.6` stage 5 is held on this: its v2 entries would re-identify the events that were
  scrubbed.
- Open for the user: is the store meant to be identity-free at rest, or was the scrub only for
  what leaves the machine? If only the latter, the right boundary is export/record, not ingest.

## Links

- Bead: `asc-i2kw` (blocks `asc-6ola.6`, `asc-o3tn`)
- The scrub: `fc8313f`, `4469340`
- Related: [0004](0004-2026-09-18-the-corpus-records-identity.md), [0014](0014-2026-09-23-scrub-collisions-blamed-on-transcripts.md)
