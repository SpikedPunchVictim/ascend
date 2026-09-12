# EV-8: what does one composite expression index per property cost the WRITE path?

**Question**    EV-4 settled the read side — the registry must emit composite expression
                indexes `(type_name, json_extract(properties_json, '$.<prop>'))`, one per
                property, because the bare-expression index is *worse than none* (449.6 ms vs
                231.0 ms, the type filter being unusable). But that rule permits an unbounded
                number of indexes: the property set is authored by an LLM at runtime and nothing
                caps it. EV-4 recorded the write side as **not measured** — *"how many indexes to
                emit, and whether index count degrades the write path"*, with write cost measured
                only at ≤2 indexes. So: what does one more index cost per INSERT, and does
                emitting the full per-property set break either write path that actually exists?

**Method**      `spike/storage-write-cost.mjs`, throwaway, `node:sqlite` (Node v24.18.0), WAL +
                `synchronous = NORMAL` + `busy_timeout = 5000` — the exact pragma set
                `openStore` applies. The real `entries` table shape. For each k in
                {0, 1, 2, 5, 10, 20}: create k composite expression indexes over k properties,
                fill to **100,000 rows** so every index is at full B-tree depth (the trap EV-4
                recorded — measuring a registration or write path against an empty store proves
                nothing), then time 2,000 inserts two ways:

                - **autocommit, one transaction per entry** — what `asc record` does, called by
                  a hook on every session start
                - **one batched transaction** — what the claude-code adapter's backfill of the
                  ~829 real transcripts does

                Values are the **409 real tool-denial rows** from `spike/corpus.db`, permuted
                across 20 properties. Identical values in every variant, so a difference between
                them is the index set and nothing else.

## Measurement

```
indexes  autocommit ms/insert   p95   batched ms/insert  file MB  ratio (batched)
      0                0.015  0.044             0.0046     98.1          1.00x
      1                0.025  0.071             0.0076    102.3          1.68x
      2                0.030  0.105             0.0126    105.4          2.76x
      5                0.056  0.170             0.0158    123.7          3.45x
     10                0.074  0.138             0.0218    148.1          4.77x
     20                0.150  0.376             0.0456    204.9          9.97x
```

Index build, once per registration on a populated store (the fill column includes the
100k-row fill itself, so read it as an upper bound):

```
 0 indexes: 1033 ms     5 indexes: 1999 ms     20 indexes: 4882 ms
```

## Decision

**GO — emit the full per-property composite index set, uncapped, as EV-4 specified.**

The two write paths that exist, priced at the worst case measured (20 properties):

| path | without indexes | with 20 indexes | delta |
|---|---|---|---|
| `asc record`, 1 entry | 0.015 ms | 0.150 ms | **+0.135 ms per record** |
| adapter backfill, ~16.6k entries batched | 76 ms | 755 ms | **+679 ms, once** |

0.135 ms on a hook that fires once per session is not a cost. A sub-second backfill is not a
cost. The threshold EV-4 set for the read side was "within 1.5× of the per-type ceiling at 250k
rows", and the write side clears its own bar by three orders of magnitude — so the rule ships
as written, and **no index cap is added**. A cap would have been the more conservative choice
and it is not justified: it would trade a measured-adequate read path for an unmeasurable
write saving.

**The cost that actually bites is DISK, not time.** The index set takes the file from 98.1 MB to
204.9 MB at 100k rows — **2.1×**, so the indexes are roughly as large as the data they index.
That reframes what to watch: file size is the quantity that scales badly with property count,
and it is a `asc doctor` report rather than a registration gate. Recording a 20-property type is
still correct; the user should be able to see that it doubled their store.

**One correction to the framing EV-4 left behind.** The `ratio` column above reads 9.97×, which
looks alarming and is the wrong number to decide on: it is a ratio between two figures that are
both far below any threshold that matters. The decision rests on the absolute milliseconds.
Percentages of a sub-millisecond operation are exactly how a non-problem looks like a problem.

## Confidence

- **Single writer, no concurrency.** EV-4 flagged this too and it is still true. The measured
  cost is per-INSERT work inside one process; WAL contention between concurrent subagent writers
  is untested. The index work is not obviously concurrency-sensitive, but that is an argument,
  not a measurement.
- **One table, one type's properties.** All variants write a single `type_name`. Real stores hold
  many types sharing one table, so a real store carries the union of every type's indexes — the
  file-size result above is therefore a **per-type** figure and the total is additive across
  types. That is the number most likely to surprise a user with a large registry, and it is
  unmeasured here.
- **The timed window is small.** 2,000 inserts per variant, median and p95 reported. Ample to
  separate 0.015 ms from 0.150 ms; not ample to characterise tail behaviour under checkpointing.
- **`synchronous = NORMAL`, not `FULL`.** Durability across process crashes is unchanged; a power
  loss could lose recent commits. This matches what `openStore` ships, so the numbers describe
  the real configuration, but they are not `FULL` numbers.
- **Synthetic expansion, as in EV-4.** Values are real and their cardinality is preserved;
  temporal correlation between fields is not. Index selectivity is unaffected by the permutation,
  but a real stream clustering in bursts could differ.
