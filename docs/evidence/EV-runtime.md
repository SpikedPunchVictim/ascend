# EV-6: does the oclif CLI cold-start fast enough to sit in a recording hot path, and does
`node:sqlite` hold up against `better-sqlite3`?

**Question**    Two coupled decisions. (a) `asc record` is called by an agent many times per task, so
                per-invocation process startup is on the critical path — is oclif's cold start cheap
                enough, or does `record` need a fast path that bypasses it? (b) ARCHITECTURE.md picks
                Node's built-in `node:sqlite` (no native dependency); does it cost anything in
                throughput against the incumbent `better-sqlite3`?

**Method**      `spike/runtime/bench.mjs`, **n=50 fresh `node` processes per arm** — cold start means
                a new process every sample, so each timing spawns `node` and measures wall clock from
                `spawnSync` to exit, including module load. Both arms do identical work: open a SQLite
                DB at the path given and write one `review-completed` entry through the same
                `spike/runtime/work.mjs#recordOne`.

                - **Arm A (`bare-record.mjs`)**: no framework; `node <file> <db>`.
                - **Arm B (`oclif-probe`)**: the same work as an oclif `Command` with one
                  `Args.string`, run through oclif's dev-mode `execute()` — the standard entry point,
                  so this is what a user would actually pay: `node <file> record <db>`.

                Throughput: 10,000 rows in a single transaction, 5 runs per arm, median reported
                (`spike/runtime/throughput.mjs`).

## Measurement

Cold start, ms:

| arm | n | min | p50 | p95 | max |
|---|---|---|---|---|---|
| bare-node | 50 | 54 | **59** | **72** | 110 |
| oclif | 50 | 116 | **123** | **169** | 186 |

oclif overhead: **p50 +65 ms, p95 +97 ms**; ratio at p50 **2.10×**.

Insert throughput, 10,000 rows in one transaction:

| engine | median | runs |
|---|---|---|
| **`node:sqlite`** | **1,201,616 rows/sec** | 477,075 · 1,196,345 · 1,201,616 · 1,291,343 · 1,368,832 |
| `better-sqlite3` | 988,435 rows/sec | 804,816 · 899,277 · 988,435 · 1,048,122 · 1,109,775 |

`node:sqlite` is **1.22× faster** at the median.

## Decision

**Both arms confirmed; no fast path needed. GO.**

**Runtime (oclif): keep oclif for the whole CLI, including `record`.** oclif's p95 of 169 ms is below
the 300 ms threshold ARCHITECTURE.md set for triggering the "fast path for `record` only" escape
hatch, so that mechanism stays in the Design Reserve — designed, not built. Promotion condition
recorded: if `asc record`'s p95 exceeds 300 ms in dogfooding (E4+), promote the bare-node fast path.

**Storage engine: keep `node:sqlite`.** It is both faster than `better-sqlite3` *and* free of a
native dependency, so the architecture's choice is confirmed on the merits rather than merely
inherited. This also removes `better-sqlite3` from `pnpm-workspace.yaml`'s `onlyBuiltDependencies`
native-build allowance list, which is a real simplification for install and CI.

Thresholds: the plan's stated escape-hatch trigger was p95 > 300 ms (measured 169 ms — not
triggered). The engine choice needed only non-inferiority; a 1.22× win decided it outright.

## Confidence

What this does **not** establish:

- **The benchmark bodies are trivial by construction.** Each arm opens a DB and writes one row. That
  is deliberate — it isolates *framework startup* — but it means these numbers are a **floor**, not a
  prediction. `asc record` will also validate against a zod schema, resolve the registry, resolve the
  project root, and possibly update views. Real `asc record` latency is unmeasured and will be higher.
- **Node version is load-bearing for arm B.** `oclif` startup on Node v24.18.0 measured 123 ms p50;
  `node:sqlite` is only available Node ≥22. Both facts are version-specific and will drift.
- **`spawnSync` overhead is included in both arms.** It is a constant, so the *difference* is
  meaningful, but neither p50 is a pure process-start figure. Comparing to another machine's numbers
  is invalid.
- **The throughput benchmark is single-threaded, no concurrency, one table, no indexes.** WAL
  contention, concurrent writers, and index-maintenance cost are not measured. EV-4 showed the write
  path degrades with index count (3.79 → 5.62 µs/row), which this test does not capture.
- **One machine, one run session.** The `node:sqlite` runs show a 2.9× spread (477k–1.37M rows/sec);
  the 477k first run is a warm-up outlier and the median is quoted to absorb it, but the variance is
  real and the two engines' distributions overlap at the edges.
- **Cold start on a cold filesystem cache was not separately measured.**
