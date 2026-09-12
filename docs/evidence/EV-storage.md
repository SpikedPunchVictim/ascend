# EV-4: which physical storage shape carries runtime-defined entry types?

**Question**    Does ARCHITECTURE.md's chosen shape — one `entries` table holding a
                `properties` JSON document, with a generated per-type view projecting
                `json_extract` into typed columns — survive real query load at scale, or does it
                lose to EAV or per-type tables?

**Method**      Four throwaway harnesses, `node:sqlite` (Node v24.18.0), WAL mode, medians of 9–20
                warm runs per query. Data is the **409 real tool-denial rows** from
                `spike/corpus.db` (extracted from `~/.claude/projects/*.jsonl`, read-only),
                expanded to 10k–250k rows by deterministic permutation of the categorical fields
                so every value is a real observed value. Three shapes were built against one
                logical dataset and asked the same five analysis questions:

                - **A** `entries(id, type_name, properties_json)` + generated view per type
                - **B** `entries` + `entry_properties(entry_id, name, value)` (EAV)
                - **C** one physical table per type

                Scripts: `spike/storage-bakeoff.mjs`, `spike/storage-scaling.mjs`,
                `spike/storage-indexing.mjs`, `spike/storage-composite.mjs`,
                `spike/storage-stored-cost.mjs`.

## Measurement

### 10,000 rows, one type, five queries (phase 1)

| query | A json+views | B EAV | C per-type |
|---|---|---|---|
| count by one categorical | 10.18 ms | 2.61 ms | **0.38 ms** |
| top-10 values with counts | 5.00 ms | 2.50 ms | **1.39 ms** |
| filter two properties ANDed | 3.97 ms | 4.53 ms | **0.47 ms** |
| crosstab of two properties | 11.35 ms | 11.35 ms | **4.12 ms** |
| property value within a date range | 5.06 ms | 8.46 ms | **1.68 ms** |
| **TOTAL** | 35.57 ms | 29.46 ms | **8.04 ms** |
| **SQL lines a human/LLM must write** | **6** | 19 | **6** |

C is fastest; B is no faster than A while costing **3.2× the SQL** (EAV's two-property filter needs
a 5-line self-join). B is eliminated on ergonomics, not speed.

### Scaling — shape A degrades superlinearly (phase 2)

| rows (one type) | A json+views | C per-type | ratio |
|---|---|---|---|
| 10,000 | 7.75 ms | 0.39 ms | 19.98× |
| 50,000 | 42.27 ms | 1.88 ms | 22.48× |
| 100,000 | 89.67 ms | 4.88 ms | 18.39× |
| 250,000 | 362.09 ms | 11.25 ms | 32.18× |

C is linear (2.3× latency for 2.5× rows). A is not: 100k → 250k is 2.5× the rows but **4.04× the
latency**. `EXPLAIN QUERY PLAN` shows A's index *is* used — the cost is per-row `json_extract` over a
non-covering index, ≈3.6 µs/row against C's ≈0.11 µs/row.

Types coexisting in one table at 100k total rows (the realistic case — a registry accumulates types):
A's *absolute* latency falls as types multiply (fewer rows match the type filter), but the ratio to C
*rises*: 19.7× (1 type) → 31.6× (5) → 32.0× (20) → 37.9× (50).

### Indexing closes the gap — but only the right index (phases 3–4)

At 250,000 rows, four queries, total median latency:

| variant | index | TOTAL | ratio to C | index build |
|---|---|---|---|---|
| A0 plain view | none | 672.5 ms | 3.10× | — |
| A1 | bare expression `(json_extract(prop))` | 449.6 ms | 2.07× | 188 ms |
| A3 | **composite** `(type_name, json_extract(prop))` | 349.2 ms | 1.61× | 462 ms |
| A4 | **composite covering** `(type_name, prop1, prop2)` | **206.1 ms** | **0.95×** | 226 ms |
| **C per-type (ceiling)** | column index | 217.1 ms | 1.00× | — |

**A4 beats shape C outright** (206.1 ms vs 217.1 ms) at equal query ergonomics. Query plans:

```
A0  SCAN entries                                          ← full table scan
A1  SCAN entries USING INDEX i_dk                         ← scans the WHOLE index; type filter unused
A3  SEARCH entries USING INDEX i_dk (type_name=?)         ← composite index, type filter applied
A4  SEARCH entries USING INDEX i_all (type_name=?)        ← covering: no table lookup at all
```

**Naive indexing of shape A is a trap.** A1's bare-expression index is *slower than no index* on the
crosstab (239.1 ms vs A0's 231.0 ms) because a single-column expression index cannot carry the
`type_name` predicate, so SQLite scans the entire index. Indexing A blindly makes it worse.

Write-path cost is negligible for every shape: 3.79 µs/row (C) to 5.62 µs/row (A2) — all in the same
band, all ≫ fast enough for a CLI.

### The generated-column path is closed on a populated table (phase 4b)

| variant | ALTER on 250k-row table | pages |
|---|---|---|
| `ADD COLUMN ... VIRTUAL` | accepted, **0.2 ms**, metadata-only | 4532 → 4532 (0.0%) |
| `ADD COLUMN ... STORED` | **REJECTED: "cannot add a STORED column"** | — |

The boundary is exact:

```
rows  STORED ALTER result
   0  ACCEPTED
   1  REJECTED: cannot add a STORED column
```

**STORED is accepted only on a zero-row table.** Every real type registration happens on a populated
corpus, so STORED is unavailable in production. Only `VIRTUAL` generated columns and expression
indexes are options.

### Cost of registering one more property on an existing corpus

| shape | operation | cost |
|---|---|---|
| A1 | `CREATE INDEX` on the new property | 150.23 ms, once, **type-agnostic** |
| A2 | `ADD COLUMN ... VIRTUAL` generated | **0.26 ms**, once, **type-agnostic** |
| C | `ALTER TABLE ... ADD COLUMN` | 2.32 ms — **but per type**, so it must be replayed for every type already in the registry |

## Decision

**Shape A confirmed — GO, with one required addition to ARCHITECTURE.md.**

Shape A is kept: C's raw speed is bought with per-type DDL, which directly contradicts the product's
defining requirement that an LLM register a type at runtime without a migration. C's registration cost
is per-type and grows with the registry (0.03 s at 13 types, seconds at hundreds); A's is one
type-agnostic statement. A shape that cannot be registered into is disqualified regardless of latency.

**Change required:** ARCHITECTURE.md specifies the generated per-type view over `json_extract` but is
silent on indexing. The measurements show the view alone is 3.1× slower than C and superlinear, and
that the obvious index (bare expression) is worse than none. The registry must therefore emit, per
type, **composite expression indexes `(type_name, json_extract(properties_json, '$.<prop>'))`** — and
a **covering** index over the property set a query shape actually groups by. With that, A4 measures
0.95× C, i.e. it wins. Without it, the analysis commands' twenty-odd queries at 250k rows cost ~13 s
of pure scan; with it, ~4 s.

Threshold that decided it: A must be within 1.5× of C at 250k rows, because a corpus of ~20 queries
per `asc analyze` run must stay interactive. Unindexed A is 3.10× (fail); composite-covering A is
0.95× (pass).

## Confidence

What this does **not** establish:

- **Scale is 3 orders of magnitude beyond the stated use case.** ARCHITECTURE.md targets "hundreds of
  entries". At the design's own scale (≤10k rows) *every* variant is single-digit milliseconds and the
  choice is settled entirely by the DDL argument, not by these numbers. The 250k measurements exist to
  prove A does not fall over, not to claim it was needed.
- **A0's absolute latency is not stable across runs.** Phase 2 measured 362 ms for one query at
  250k/1 type; phase 4 measured 239.9 ms for the same query at the same size. The plans differ between
  runs (`SEARCH ... USING INDEX idx_entries_type` vs `SCAN entries`) — the unindexed view's plan is
  planner-dependent. Phase 4's within-run comparisons are the trustworthy ones; cross-script absolute
  A0 numbers are not. This instability is itself an argument for emitting explicit indexes.
- **The index set was hand-chosen to match the queries.** A4's covering index was built for exactly
  the two properties the crosstab groups by. A real registry does not know the query shapes in advance.
  The open question this leaves — *how many indexes to emit, and whether index count degrades the
  write path* — is not measured here. Write cost was measured with ≤2 indexes.
- **One type's property set.** All timings use 5 properties. Wide types (20+ properties) were not
  measured; `json_extract` cost is per projected column, so a wide type is expected to scale worse.
- **Single-user, single-writer.** No concurrency measurement. WAL and `busy_timeout` behaviour under
  concurrent writers is untested.
- **Synthetic expansion.** Rows are real values permuted, not real event streams. Cardinality of the
  categorical fields is preserved; temporal correlation between fields is not (real denials cluster in
  bursts, which affects index selectivity).

## Correction: a false green found in this task's own harness

An earlier revision of this experiment (`spike/storage-indexing.mjs`, phase 3) reported
*"ALTER TABLE ADD COLUMN ... STORED is ACCEPTED at runtime"* and recorded a **0.26 ms** registration
cost for the generated-column path. **Both were wrong.**

The ALTER was executed against a table that had just been dropped and recreated — zero rows — and the
0.26 ms figure was measured with `VIRTUAL`, not `STORED`. Re-running the same ALTER against a populated
table rejects it outright at ≥1 row. The test had exercised the single condition that cannot occur in
production (registration on an empty corpus) and reported it as a general property of the design.

This is the "reports success wrongly" class: the number was not merely imprecise, it was a claim that
would have shipped a design failing on the first real type registration. Corrected in phase 4b above.
The lesson recorded for E2+: **any measurement of a runtime registration path must run against a
populated store**, and the harness should assert population before measuring.

## Follow-up (2026-09-12, `asc-865.1`): a property name is not always free

EV-4 decided the shape of the generated view — one table, a JSON document, `json_extract` projected
into typed columns. It did not ask what happens when a property's canonical name is **already a column
name of the view**, because every fixture used names the envelope does not claim.

Question: does a property named `source` (or `id`, `actor`, `repo`, `branch`, `workflow`, `run_id`,
`recorded_at`, `type_name` — all plausible property names) project faithfully beside the envelope column
of that name?

Method: the real `registerType` + `recordEntry` path, type `note` with properties `source` and `id`,
then read the view's declared columns and query it.

```
VIEW COLUMNS: ["id","type_name",...,"source",...,"na_json","id:1","id_state","source:1","source_state"]
SELECT source, id FROM v_note_v1   ->   {"source":"self","id":"e1"}
```

The property values recorded were `from-the-llm` and `the-prop-id`. **SQLite does not error on the
duplicate: it keeps the first column and renames the later one to `<name>:1`.** Both envelope values
came back under the property names, so the exact query `ARCHITECTURE.md` prescribes for the view
(`SELECT <prop>, COUNT(*) FROM v_<type>_v<n> GROUP BY 1`) returns a wrong answer with no error — the
plausible-wrong-number class this product exists to prevent, and the reason it outranks a style question.

The same mechanism was measured again under mutation, from the opposite side: with the generator's
guard removed, a definition carrying `source` rebuilds the defect exactly —
`["source","source:1","source_state"]`.

Decision: the names a view claims are **refused as property names at define time**
(`@ascend/core`'s `reservedPropertyName`; the vocabulary is the projection list itself, so the two
cannot disagree), and `refreshTypeViews` refuses as well for a version row that reached the store
without the registry. The rejected alternative — prefixing the view's property columns — fixes the whole
class but charges every query a prefix for the minority of names that collide; it is held as a Design
Reserve with its promotion condition recorded in `IMPLEMENTATION_PLAN.md`.

Confidence: high on the mechanism (reproduced twice, both directions, on the real path). The
**residual hole is stated rather than papered over**: a store that already holds such a family keeps its
existing (wrong) view — views are derived state, `refreshTypeViews` now refuses instead of rebuilding
it, and a registered definition is immutable, so the repair is a new major version with the property
renamed. No such store exists in this repo or in any released build; the state is reachable only by
hand-written SQL, which is what `union.test.ts`'s bypass fixture does.
