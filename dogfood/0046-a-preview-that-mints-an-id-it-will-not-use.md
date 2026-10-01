# 0046 — a preview that mints an id it will not use

| | |
|---|---|
| **Bead** | `asc-mw1u` |
| **Surfaced** | 2026-09-30 |
| **Surfaced by** | running `asc record … --dry-run` to validate three entry documents before writing them, then running the same commands for real and comparing the two outputs |
| **Entry type(s)** | `probe` (scratch, project-defined) — used only because a throwaway store makes the ids unambiguous; the finding is in `asc record --dry-run`, not in any entry |
| **Severity** | P3 — nothing is written wrongly and nothing is lost; the refusal a caller meets is clear and comes before any damage |
| **Status** | fixed in the working tree (the minted id is omitted; `ascend_output` 2 → 3) |

## What was found

`asc record` mints a random UUID for any entry whose document does not name one
(`record.ts:692`, `id: merged.id ?? randomUUID()`). **`--dry-run` mints its own.** So the id a
dry run reports is never the id the write produces — not "usually differs", but cannot be the
same, because the two runs are two different calls to `randomUUID`.

`--dry-run`'s stated contract is *"Validate everything and report what would be written, then
write nothing"*, and `--dry-run --json` returns a row that looks exactly like the row a write
returns: same `type_hash`, a `recorded_at`, a `states` map, `"dry_run":true` as the one field
that distinguishes it. Nothing in the output says the `id` is a specimen. A caller who keeps it
— the obvious thing to do with a preview of an id, since `asc invalidate` takes ids — will fail
to find it.

This is an *absence*: no code is wrong and no invariant is broken. The command reports a value
it had to invent, and does not say that it invented it.

## How it surfaced

By doing the recommended thing. Three `decision` entries were being recorded at the close of
the invalidation work, and the commands were dry-run first so that a malformed
`options_considered` array could not reach an immutable store. Both outputs were on screen
together, and the ids did not match.

**Nobody was looking for this.** The dry run was being read for its *warnings* — whether the
documents validated — and the ids were incidental. Nothing about recording decisions invites a
reader to compare the two runs' identifiers; that comparison happened because the two outputs
were adjacent, not because anyone suspected the field.

## The metric

Measured 2026-09-30 on a scratch store (`asc init`, one scratch type), driving the built binary.
Three dry runs and three real runs of byte-identical content:

| | ids reported |
|---|---|
| dry run ×3 | `00ca6f2b-57af-4aa3-ac8f-b9c5dc5ead0a`, `8d342d98-4fe0-42bf-9e50-3683239f694b`, `1f2c2ee4-210d-4d98-90a8-53cca57a4f68` |
| real run ×3 | `955acceb-bc62-4294-8093-c24f07691340`, `fa91eea8-d64c-407c-b235-308acc847ef4`, `de64ec14-19c4-4443-9753-14666a1b3b04` |
| what the store held | `955acceb…`, `fa91eea8…`, `de64ec14…` — **exactly the real runs** |

Six ids, no overlap. The exact rows, one from each arm:

```
$ asc record probe --prop=note=same --dry-run --json
{"ascend_output":2,"rows":[{"index":0,"id":"00ca6f2b-57af-4aa3-ac8f-b9c5dc5ead0a","type":"probe","version":1,"type_hash":"de33f502b7aa4ed49321ac0cc08f68452cf1ec8450a9ae53c4d7712d54c84fe0","recorded_at":"2026-09-30T21:00:46.873Z","source":"self","states":{"note":"measured"},"na":[],"warnings":[],"dry_run":true}],"row_count":1,"coverage":{"shown":1,"total":1,"has_more":false,"percent":100}}

$ asc record probe --prop=note=same --json
{"ascend_output":2,"rows":[{"index":0,"id":"955acceb-bc62-4294-8093-c24f07691340","type":"probe","version":1,"type_hash":"de33f502b7aa4ed49321ac0cc08f68452cf1ec8450a9ae53c4d7712d54c84fe0","recorded_at":"2026-09-30T21:00:47.484Z","source":"self","states":{"note":"measured"},"na":[],"warnings":[],"dry_run":false}],"row_count":1,"coverage":{"shown":1,"total":1,"has_more":false,"percent":100}}
```

**The scope is exactly one condition**: a document that NAMES its id is reproduced faithfully.
Same store, same type, same run:

```
$ asc record probe named.json --dry-run --json   → id 11111111-2222-3333-4444-555555555555
$ asc record probe named.json --json             → id 11111111-2222-3333-4444-555555555555
```

`recorded_at` also differs between the arms, and that is not part of the finding: a preview
inevitably happens at a different instant, and no caller carries a previewed timestamp forward
the way it would carry an id into `asc invalidate`.

The consequence, when a caller does act on it — this is the refusal that makes the severity P3
rather than higher:

```
$ asc invalidate 4c752a89-a381-409d-be92-2488c8a7f261 --label=wrong_value --reason="acting on what the dry run reported"
Error: entry '4c752a89-a381-409d-be92-2488c8a7f261' does not exist, so there is
nothing to invalidate. Invalidation annotates an EXISTING entry -- the
immutability trigger's own message says "invalidation is an annotation scheme,
not an edit" -- it is not a tombstone for an id that was never recorded, and
accepting one here would let a caller invalidate an entry it can never point
back to.
exit=1
```

## The pattern

**A preview must report only what the write will honour, or say which parts it cannot.** The
class: a `--dry-run` that is *forced* to invent a value, because the value is minted at write
time, and then presents the invention in the same shape as the real thing. This is the
mirror-image of the report this project has already recorded (`EV-38`'s `writeLines` reporting
`stale: false` for a replay that went to a replaced inode): there, a real report was untrue;
here, a true-ish report is about a run that does not exist.

The distinguishing test is whether a caller would CARRY the value forward. A previewed
`recorded_at` is carried by nobody; a previewed `id` has exactly one obvious destination, and it
is a command that takes ids.

## Why nothing else would have caught it

A test would have had to assert a dry run's id equals the following write's id — and that
assertion cannot be written, because it is false by construction. The dry run's own tests check
what a dry run is *for*: that nothing is written, that warnings still fire, that the envelope
carries `dry_run: true`. All of that is true.

A review would not have caught it either, and for a reason worth recording: `dry_run: true` is
right there in the row. A reviewer checking that the field exists finds it and stops; the field
is doing its job of marking the arm, and it does not claim to mark which *values* are
provisional. The gap is between what the flag marks and what a reader takes it to cover.

## Consequences and constraints

**Two repairs, and the choice is not obvious.** `randomUUID` is called in one place
(`record.ts:692`), so both are small:

- **Omit the id when it was minted.** The preview is then honest by construction — every field
  present is one the write will keep — and a caller cannot carry away a value that does not
  exist. The cost is a row that differs in shape between the arms, which is the thing
  `dogfood/0045`'s sibling decision (`types list`'s `struck` column is present-but-null rather
  than absent, so a column set never varies with the data) argues against.
- **Keep the id and say it is provisional.** No shape change, and the reader is told. The cost
  is that the warning has to travel in the row and in the table rendering both, and that the
  honest sentence is long: "minted at write time; this is a sample".

Neither is clearly right, which is why this is filed rather than fixed: it is a small
user-facing contract question — what does `--dry-run` promise about the values it prints — and
that is the owner's to settle, not a mechanism to be inferred from the code.

**No data is at risk either way.** The entries this was found while recording are already in the
store and are unaffected; the finding concerns a preview only.

## Links

- Bead: `asc-mw1u`
- Related records: `dogfood/0045` (the finding recorded in the same session, minutes earlier);
  `EV-38` (the mirror-image shape — a report that was untrue rather than a true report about a
  run that does not exist)
- Code: `packages/cli/src/commands/record.ts:692` (`id: merged.id ?? randomUUID()`)
