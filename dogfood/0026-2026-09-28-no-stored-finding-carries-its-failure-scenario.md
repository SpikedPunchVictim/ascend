# 0026 — no stored review finding carries the field that makes it more than a suspicion

| | |
|---|---|
| **Bead** | `asc-my84` |
| **Surfaced** | 2026-09-28 |
| **Surfaced by** | the first run of `asc doctor` (`asc-12a`) against this project's store |
| **Entry type(s)** | `review_finding` (derived) |
| **Severity** | P2 |
| **Status** | fixed (uncommitted): the absence is now stated on the type, which is what the owner chose — see "How it was decided" |

## What was found

This is an absence. `review_finding` declares `failure_scenario`, and the type's own description
calls it "the field that separates a real finding from a suspicion". None of the entries this
store holds carries it. The deriver is not at fault. Every stored entry came through the parsed
route, which reads the tables in bug-hunt reports, and those tables have no scenario column. So
every review finding in the store is a suspicion by the type's own definition, and nothing
anywhere says so.

## How it surfaced

`asc doctor` counts, for each property, how many of the entries that declare it actually
measured it. Its first real run printed a `warn` on this property. The first reading of that
warning was wrong, and how it was wrong is part of the finding:

1. Every real `ReportFindings` call carries `failure_scenario`, so the zero looked like a
   value lost between the call and the store.
2. A fresh ingest of one such transcript into a scratch store wrote the field on every entry.
   The deriver was therefore correct.
3. Grouping the live entries by `captured_by` gave the actual cause. All of them are `parsed`.
   All 33 `ReportFindings` calls are in ephemeral probe projects, which ingest skips by design.

Nobody was looking for it. The check was built to find dead types and drifting definitions, and
this was the first thing it printed that nobody had predicted.

## The metric

From `asc doctor` on this project's store:

```
property_states  warn    review_finding.failure_scenario      measured 0 of 112, not_applicable 0, not_measured 112
```

From `asc query "SELECT json_extract(properties_json,'$.captured_by') cb, COUNT(*) FROM entries
WHERE type_name='review_finding' GROUP BY 1"`:

```
cb      COUNT(*)
------  --------
parsed  112
```

The next two counts come from a read-only script over `~/.claude/projects` that parses each
`ReportFindings` `tool_use` block. They are counts only; no text was printed.

```
calls 33 findings 358
{'file': 358, 'line': 358, 'category': 358, 'verdict': 358, 'summary': 358, 'failure_scenario': 358, 'short_summary': 194}
```

The same calls, classified with the adapter's own `isEphemeralProject`:

```
{ ephemeral: 33, durable: 0 }
```

The scratch-store check ingested one probe transcript into a fresh `asc init` store:

```
n   fs
--  --
12  12
```

The 112 entries are not 112 independent findings. `dogfood/0024` records that 47 of them are
twins written under an earlier handler hash. The metric above counts entries, not findings.

## The pattern

A type with two capture routes can be filled entirely by the weaker one, and when that happens
the gap is invisible. Each route is correct on its own terms. The route that carries the field
exists, is tested, and has fired 33 times, but only in the places ingest leaves out. Reading
the type's definition, the deriver or the handler tells you nothing. The gap only shows up in
the distribution of the stored data, which is exactly what a per-property state count reads.

## Why nothing else would have caught it

- The deriver's tests use `ReportFindings` fixtures, and those carry the field.
- The handler's tests check that table rows map to entries, and they do.
- `asc explore review_finding` would have shown the same count, but only to someone who ran it
  and read that one property's row among thirteen.

Nothing aggregated "declared but never measured" across the registry until `doctor` did.

## Consequences and constraints

Entries are immutable, so the 112 cannot be backfilled with a scenario they never had. The
options are all at write time: map a scenario-like column in the table handler, get the
reported route to fire on real work through the `on_skill` nudge, or state on the type that
parsed entries never carry the field, as `catchable_by` already does. They were listed on
`asc-my84` and decided there — see below.

## How it was decided

The owner chose **(b) + (c)** on 2026-09-28, recorded on `asc-my84` verbatim: *"rely on the
`on_skill` nudge to get `ReportFindings` firing in real work, AND state on the type that
table-parsed entries never carry `failure_scenario` (as `catchable_by` does)."*

What that is, uncommitted:

- **(b)** is `handlers/review-finding-nudge.yaml`, which already existed and is pinned by tests
  that it speaks at the moment `bug-hunt` loads and names all nine lens slugs.
- **(c)** is three prose edits, all of them on surfaces a recorder or a reader actually sees:
  `review_finding`'s own description now says the reported route is the only one that fills the
  field; `failure_scenario`'s property description says it is absent on every `parsed` entry **by
  construction**, naming the handler that has no column to read; and
  `handlers/review-finding-table.yaml` says the same thing in its own header.
- The handler states it **in prose and deliberately not** as `judged: [failure_scenario,
  catchable_by]`. Measured 2026-09-28: `judged:` moves the handler's hash (`packages/core/src/handler.ts:1148`
  hashes the whole parsed document, and the entry key carries it — `packages/cli/src/typed-handlers.ts:252`),
  and `asc ingest claude-code --dry-run` goes from `entry review_finding none` to
  `65 new, 11 rejected`. That is the parsed corpus written a second time, needing a hand migration
  of the kind `dogfood/0024` documents — for a declaration that emits nothing. A test pins
  `handler.judged` to `[]` as the speed bump for anyone who adds it back.

The field is still absent on all 112, and that is (c) rather than a failure of it: the measurement
did not change, the statement about it did. `asc doctor` will go on reporting
`failure_scenario 'measured 0 of 112, not_measured 112'`, and is now right to.

## Links

- Bead: `asc-my84`
- Found by: `asc-12a` (`asc doctor`), commit `c562c4e`
- Related: `dogfood/0024` (the twins inside the 112), `dogfood/0029` (the same type, one day
  later: a prose write that landed on a version nobody reads)
