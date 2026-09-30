# 0045 — a surface that projects a column its own filter cannot name

| | |
|---|---|
| **Bead** | `asc-bqb5` |
| **Surfaced** | 2026-09-30 |
| **Surfaced by** | trying to look at the struck entries of one type, to decide what `asc-9xi0` should change on the read path |
| **Entry type(s)** | `decision` (starter) — the type used in every arm below; the finding is in `asc explore`'s filter language, not in any entry |
| **Severity** | P2 — nothing is written wrongly and no data is lost; a question the command displays the answer to cannot be asked of it |
| **Status** | fixed in this working tree (the `--struck` flag) |

## What was found

`asc explore <type>` prints an `invalidated` row, and `asc explore <type> --filter` is the flag for
narrowing that population. The two do not meet. **`--filter` cannot name `invalidated`**, because the
predicate is evaluated over a projection of the type's own columns — envelope columns plus declared
properties (`type-filter.ts`, `asc-56k`) — and `invalidated` is not among them: it is a row the
command COMPUTES and prints, not a column any table holds.

This is an *absence*: nothing in the code anticipates it. No check refuses the name, nothing warns,
and the help is truthful about what `--filter` accepts. What a caller gets instead is SQLite's own
complaint, quoted below — accurate about the string it was handed, and addressed to someone who
might have written it, never to the gap between the map's own row and the map's own filter. The
command displays a number, and there is no invocation that selects the rows that number counts.

## How it surfaced

By trying to use the tool for the job it was already doing. Deciding what `asc-9xi0` should move on
the read path required an inventory of what the struck entries of one type actually are — and the
only way to see them was `--filter`, which is the flag that exists for exactly that.

**Nobody was looking for this defect.** I was looking for struck rows, and the tool named the column
it had just shown me and refused it. That distinction matters here: the finding was not the result of
auditing the filter language, and no amount of reading `explore.ts`'s help text would have produced
it — the help is correct, and the gap is between two correct parts.

Measured 2026-09-30 against this repository's own store, driving the built binary:

```
$ node packages/cli/dist/bin.js explore decision --filter "invalidated is not null"
exit=1
Error: SQLite could not make sense of a statement: 'no such column: invalidated'
(code 1). Either the SQL is not valid, or it names a table or column the store
does not have -- SQLite reports both as this one code, and the wording above is
what says which. An ascend store's tables are entries, entry_types, annotations,
annotation_schemes, meta and the full-text index entries_fts, plus one generated
view per entry type named 'v_<type>_v<version>'; 'asc types list' names the
types that exist. If the statement was not one you wrote, this is a bug in
ascend.
```

The error's own last line is the finding: `explore --filter` is a caller-written statement, it names
a column the command itself printed one line earlier, and the message therefore lands on the wrong
side of its own fork.

**The size of the population this hid**, from the same store on the same day:

```
$ node packages/cli/dist/bin.js query "SELECT COUNT(*) AS total FROM entries" --json
{"ascend_output":2,"rows":[{"total":6601}],"row_count":1,"coverage":{"shown":1,"total":1,"has_more":false,"percent":100}}

$ node packages/cli/dist/bin.js query "SELECT COUNT(*) AS struck FROM annotations WHERE scheme = 'invalidation'" --json
{"ascend_output":2,"rows":[{"struck":3144}],"row_count":1,"coverage":{"shown":1,"total":1,"has_more":false,"percent":100}}
```

3,144 of 6,601 entries (47.6%) had stopped counting, and no invocation could show one of them by
that fact. The type used above is not an extreme: `asc types list --csv` reports
`decision,1,4,94,1,100,active` — 94 live, 1 struck — and that single struck entry is one that
`asc explore decision --filter "invalidated is not null"` could not reach.

After the fix, the same question, asked the way the surface now offers:

```
$ node packages/cli/dist/bin.js explore decision --struck --json > /tmp/struck.json
$ node -e 'for(const r of require("/tmp/struck.json").rows) if(r.field=="count"||r.field=="invalidated") console.log(JSON.stringify(r))'
{"field":"count","value":1}
{"field":"invalidated","value":"100.0% (95% CI 20.7-100.0%, n=1)  [SMALL GROUP n=1 < 20 -- treat as anecdote, not estimate]","tally":"1 (100.0%)","count":1,"denominator":"entries","proportion":{"successes":1,"n":1,"p":1,"lower":0.20654931437723745,"upper":1,"confidence":0.95,"smallGroup":true}}
```

## The metric

| | |
|---|---|
| `asc explore decision --filter "invalidated is not null"` | exit **1**, `no such column: invalidated` (exact text above) |
| `asc explore decision --group-by invalidated` | exit **1**, names the property and lists the four declared ones |
| `asc explore decision --select invalidated` | exit **1**, names the property and lists the four declared ones |
| entries in this store | **6,601** |
| rows carrying the `invalidation` scheme | **3,144** (47.6%) |
| struck entries of `decision` | **1** of 95 recorded |
| `asc explore decision --struck --json`, `count` row | **1** |
| `asc explore decision --struck --json`, `invalidated` `count` | **1** (tally `1 (100.0%)`) |

No group here is under `MIN_N` in the sense `proportion.ts` means — these are counts of rows, not
estimated shares, and each is a census of the store rather than a sample of it.

## The pattern

**A surface that computes a value must be able to filter by it**, or the value is display-only. The
generalization: whenever a renderer derives a field rather than reading one, that field is invisible
to every mechanism that reads the underlying table.

The stronger form of the finding, and the one that makes it a defect rather than a gap: **the command
already refuses this name everywhere else, and `--filter` is the one door it leaves open.** Measured
on the same type, same day:

```
$ node packages/cli/dist/bin.js explore decision --group-by invalidated
Error: 'invalidated' is not a property of 'decision'. Declared properties:
chosen, options_considered, rationale, reversibility.
exit=1

$ node packages/cli/dist/bin.js explore decision --select invalidated
Error: 'decision' declares no property named 'invalidated', so --select cannot
flatten it. Declared properties: chosen, options_considered, rationale,
reversibility.
exit=1

$ node packages/cli/dist/bin.js explore decision --filter "invalidated is not null"
Error: SQLite could not make sense of a statement: 'no such column: invalidated' …
exit=1
```

Two of the three name the problem and list what would have worked. The third hands the string to
SQLite, whose message names no property and suggests nothing — and its final sentence,
*"If the statement was not one you wrote, this is a bug in ascend"*, is addressed to a caller who
wrote it, so the one branch that would report this as a defect is the branch it does not take. (There
is no `--sort`; `--page` is the stable order and takes none.)

That asymmetry is why this reads as an oversight rather than a design: the command is careful to
explain what it cannot group by and cannot select, and says nothing about what it cannot filter by.

## Why nothing else would have caught it

A test would have had to *want* to filter BY `invalidated`, and no test did — which is the finding,
not the excuse: the row's own suite (`explore.test.ts`, `asc explore: invalidated -- how much has
stopped counting (asc-k6p.1)`) asserts its count, its tally and its per-label breakdown, all by
reading the map's output, and while one of those tests does exercise `--filter` (`an entry the filter
excludes is not counted, invalidated or not`), it asks the filter language to *narrow the
denominator*, never to select on `invalidated` itself.

A review plausibly *would* have caught it, and did not, for a reason worth recording: `--filter`'s
help text is long, specific and correct about the hazards it knows —

```
--filter=<value>
    A SQL predicate over this type: a declared property (e.g. stage) and an
    envelope column (e.g. cwd) both compare bare. … WATCH A BOOLEAN: it compares
    as the stored INTEGER, not the printed word -- "...=true" and "...=1" both
    match; "...='false'" silently matches ZERO rows instead of failing …
```

— and it names the two kinds of name that work without ever claiming those are the only two. A
reader checking this help against the map finds no contradiction: nothing here says `invalidated`
would work, and nothing says it would not. The omission is not a false statement, which is exactly
why reading for one does not find it.

## Consequences and constraints

**`asc explore` keeps its whole population, and that constrains the fix.** The obvious repair — make
the struck rows disappear from the default map — is wrong: the `invalidated` row is a share *of*
`count` (`explore.ts:432-474`), so a live population would make that row always zero and kill
`asc-k6p.1`. That is why the answer is a flag that narrows the population rather than a change to
what the population is, and why `asc types list` (live, with the struck count beside it) and
`asc explore` (everything recorded, narrowed on request) now print different numbers for the same
type. The two disclose enough to reconcile — 94 + 1 = 95 — and the deliberate divergence is recorded
on both.

**The flag composes rather than branches.** `--struck` joins the same scope `--filter` threads
through the map, `--page`, `--sample` and `--group-by`, so `--struck --filter ...` is one scope over
the same projection rather than two predicates that could disagree. It is refused with `--dump` for
the reason `--filter` is: a dump's manifest has nowhere to record what thinned it.

## A correction to `dogfood/0034`

`0034` says that of the two casts in `listInvalidations`, `asc import` "enforces **neither** of the
two things the cast assumes". That is wrong for the **label** cast, and it is worth correcting in
place rather than leaving, because 0034's own metric is an argument about which writer can produce a
value the type does not admit:

- **The label cast IS protected.** `asc import` reaches the reserved name through
  `restoreInvalidationScheme` (`annotations.ts:452`), which refuses any scheme line whose
  `schemeHash(spec)` differs from `INVALIDATION_SCHEME_SPEC`'s — "the reserved scheme is always the
  labels `'wrong_subject'`, `'wrong_value'`, `'superseded'` with no rules". A stream carrying a
  different label under that name does not reach `recordAnnotations` at all.
- **The reason cast was not.** `recordAnnotations`' only note gate is
  `note !== undefined && note === ''` (`annotations.ts:769`), so an **absent** note became SQL
  NULL and a **whitespace-only** note was stored verbatim, both with `asc import` exiting 0. That
  half of 0034 stands, and `asc-4wx6` is now refused in the corpus parser instead
  (`requireInvalidationReason`, `jsonl.ts`) — the same shape and place E12.6 put "a type line must
  state its version".

`0034` is immutable, so the correction lives here. The claim it overstated is not the one that
mattered, and the reason it is recorded anyway is that a record of false scope is the kind of thing
a later reader cites to justify changing code that is already correct.

## Links

- Bead: `asc-bqb5` (this finding); `asc-9xi0` (the read half it was found while measuring);
  `asc-4wx6` (the write half)
- Related records: `dogfood/0034` (the invariant a second writer does not enforce — corrected above);
  `dogfood/0041` (a strike nothing counts — the finding that made this population interesting)
- Recorded decisions this respects: `sql.ts:68-73` (views carry `invalidated`, unfiltered);
  `registry.ts:778-785` (`listTypes` does not filter deprecated types); `profile.test.ts:910`
  (`asc-88m`, explore's population is the whole type)
