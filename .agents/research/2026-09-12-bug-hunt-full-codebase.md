# Bug Hunt — `ascend`, full codebase

**Date:** 2026-09-12
**Scope:** Full codebase — `packages/core`, `packages/store`, `packages/cli`, `packages/analysis` (4 packages, 3,974 lines of CLI source plus 2,467 lines of store source, 26 test files)
**Lenses:** All 9
**Runtime context (as answered):** Node CLI on macOS + Linux; **also Windows**; **also as an imported library**; **also the Claude Code adapter (E5 — not built)**. Lens 7 (environment divergence) therefore applies with Windows path handling in scope, and library-API reachability counts as a live runtime.
**Base revision:** `40b6e1e` (working tree clean)

## How to read the confidence labels

- **Confirmed (empirical)** — I ran the built code and the output is in this report. Every finding below that is labelled this way has a command and its result.
- **Traced** — mechanism verified clause-by-clause against source, not executed.
- **Suspected** — plausible, not fully traced. **All `Suspected` items are in §10, never in the BUG list.**

Every claim in this report comes from a file read or a command run in this session. Where I was wrong earlier in the hunt, the correction is in the Refutation Log (§9) rather than quietly dropped — four headline claims died there, all but one to errors in my own probes.

---

## 1. Guard Map

Located before hunting. Steps 4 and 5 grepped **these** files, not just the flagged file's neighbourhood.

| Guard kind | Path |
|---|---|
| Spec canonicalization, reserved names, hashing, diff | `packages/core/src/spec.ts` |
| Per-property zod schemas, `buildSchema`, `describeProperty`, `exampleValue` | `packages/core/src/schema.ts` |
| `validateEntry` (state resolution), `recordCommand` (suggested fix) | `packages/core/src/state.ts` |
| DDL: CHECKs, triggers, FTS5 virtual table, enum immutability triggers | `packages/store/src/schema.ts` |
| Pragmas + `verifyPragmas` read-back, `readOnly`, migrations, `NewerSchemaError` / `StaleStoreError` | `packages/store/src/db.ts` |
| Registration refusal path, `updateTypeProse`, deprecate | `packages/store/src/registry.ts` |
| `assertProjectable`, `ensurePropertyIndex`, `refreshTypeViews`, generated views | `packages/store/src/views.ts` |
| `requireNonEmpty` / `requireUtcTimestamp`, the single `INSERT INTO entries` | `packages/store/src/recorder.ts` |
| `attachStore` / `unionEntries` (cross-project ATTACH) | `packages/store/src/union.ts` |
| `toFtsMatch`, `MIN_TERM_LENGTH`, `searchEntries` | `packages/store/src/search.ts` |
| Exit-code mapping, error rendering | `packages/cli/src/errors.ts`, `packages/cli/src/base.ts` |
| The single-write-path source scan | `packages/store/test/recorder.test.ts:544-600` |
| The purity ban that proves it fires | `packages/core/test/purity-enforcement.test.ts` |
| Boundary rules (only `@ascend/store` may touch SQLite) | `align.config.ts:63-75`, `eslint.config.js:51` |
| Project invariants | `TASKS.md` #5, #6, #7; `KICKOFF.md`; `ARCHITECTURE.md` |

**Absence claims in this report are made against this map.** No finding asserts "X does not exist anywhere"; each names the places searched.

---

## 2. Summary

| Class | Count |
|---|---|
| **BUG** — real risk, no guard, realistic, reachable | **12** |
| **FRAGILE** — correct today, breaks under a foreseeable change | **9** |
| **OK** — guarded, intentional, or dead | 8 |
| **Needs human review** | 3 |
| Killed during refutation | 5 |
| Unverified sub-claims carried forward as `Suspected` | 3 |

The last four findings (B11, B12, F8, F9) came from a supplementary read-only CLI pass, verified by me before inclusion — see §5b. Three of the four are concentrated in `--across`, which now carries four separate defects (F2, B11, B12, and F2's sibling in `union.ts`); that command is the least-tested surface in the repository and should be treated as one unit of work rather than four.

---

## 3. Issue Rating Table

Blast radius is the three-axis notation: **code / data / coordination**.

| # | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort |
|---|---|---|---|---|---|---|---|---|---|
| B1 | A required property named `constructor` records as `measured` when never provided; marking it N/A correctly is **refused** | 1, 8 | Confirmed (empirical) | Critical | Low | High | High | 2 files / none / none | S |
| B2 | The tool's own suggested re-record command stores a **fabricated measurement** (`--prop=missing=<string>` → `"<string>"` in the ledger) | 3, 9 | Confirmed (empirical) | Critical | Low | High | High | 1 file / none / none | S |
| B3 | Non-ASCII full-text search silently returns **zero**: the index holds the terms, `toFtsMatch` cannot ask for them | 3, 8 | Confirmed (empirical) | High | Low | Medium | High | 1 file / none / none | S |
| B4 | Concurrent writers fail `database is locked` in **0–1 ms** despite WAL + a 5 s busy timeout; `db.ts`'s comment claims the opposite | 6 | Confirmed (empirical) | High | Low | Medium | High | 2 files / none / none | S |
| B5 | A **read-only** open skips the ahead-of-build guard — a v99 store is refused by a writable open and read happily by a read-only one | 2, 8 | Confirmed (empirical) | High | Low | Medium | High | 1 file / none / none | S |
| B6 | `asc init` in a repository **subdirectory** exits 0 and leaves the store **un-ignored**, so `ascend.db` can be committed | 1, 7 | Confirmed (empirical) | High | Low | High | High | 1 file / none / none | S |
| B7 | `asc init` replaces a **symlinked** `.gitignore` with a regular file (contents preserved; the link is silently destroyed) | 7 | Confirmed (empirical) | Medium | Low | Medium | Medium | 1 file / none / none | S |
| B8 | Duplicate `--prop` **silently drops the first value** — exit 0, empty stderr, an immutable ledger holding a value the caller did not intend | 1, 3 | Confirmed (empirical) | High | Low | High | High | 1 file / none / none | S |
| B9 | A `json` property accepts a `Date`, marks it **`measured`**, and stores `{}` | 8, 9 | Confirmed (empirical) | Medium | Low | Medium | Medium | 1 file / none / none | S |
| B10 | `types export` on an empty registry emits **0 bytes**; `types import` of that output fails — the tool's output is not its own input | 4, 5 | Confirmed (empirical) | Medium | Low | Low | Medium | 2 files / none / none | S |
| F1 | The single-write-path guard **evades 4 of 6** write forms (`INSERT OR REPLACE`, `REPLACE INTO`, `INSERT OR IGNORE`, multi-line SQL) — a false-green guard | 3, 8 | Confirmed (empirical) | High | Low | High | High | 1 file / none / none | S |
| F2 | `--across` accumulates one ATTACH per project and hits `SQLITE_MAX_ATTACHED` at 11 — while `unionEntries` implements a workaround for the same limit | 8, 3 | Confirmed (empirical) | Medium | Medium | Low | Medium | 2 files / none / none | M |
| F3 | Per-property prose keys are stored **verbatim** while the contract says canonical, so `reviewKind` is written and never found | 9 | Confirmed (empirical) | Medium | Low | Low | Medium | 2 files / **existing rows may hold bad keys** / none | S |
| F4 | A duplicated property name registers with only a warning, and the two enforcers **disagree in opposite directions** (`validateEntry` refuses `k=5`; `buildSchema` accepts it) | 8, 4 | Confirmed (empirical) | Medium | Low | Low | Medium | 1 file / **existing ambiguous types cannot be deleted** / none | S |
| F5 | `assertProjectable` misses a **dotted** property name: the view column reads NULL and the index never matches, while `properties_json` holds the value | 3, 8 | Confirmed (empirical) | Medium | Low | Medium | Medium | 1 file / none (hand-insert only) / none | S |
| F6 | `indexName` **collides** (`test`+`run_count` vs `test_run`+`count`) and the second index is silently never created | 8, 1 | Confirmed (empirical) | Low | Low | Low | Low | 1 file / none / none | S |
| F7 | `unit` is not trimmed, so `" ms "` forces a **MAJOR** version bump | 3, 9 | Confirmed (empirical) | Low | Medium | Low | Low | 1 file / **hash of existing rows** / none | S |
| B11 | A project directory named `temp` (or `Temp` / `main`) makes `--across` fail with a **raw driver error**, despite a comment claiming the alias is seeded against exactly this | 1, 7 | Confirmed (empirical) | Medium | Low | Medium | Medium | 1 file / none / none | S |
| B12 | The `--across` example in `--help` **can never work** (`fs.globSync` has no tilde expansion), and the error blames quoting — which is what broke it | 5, 7 | Confirmed (empirical) | Medium | Low | Medium | Medium | 1 file / none / none | S |
| F8 | `--table` truncation slices by UTF-16 code unit, so it can emit a **lone surrogate** (`�`) into the one view a human reads | 3, 7 | Confirmed (empirical) | Low | Low | Low | Low | 1 file / none / none | S |
| F9 | A comment asserts the attachment is released by the caller's `finally` "even on this throw" — `attachScope` is called **outside** that `try`, so on a `DuplicateProjectError` it is not | 2, 5 | Traced | Low | Low | Low | Low | 1 file / none / none | S |

*B11, B12, F8 and F9 were found by a supplementary read-only CLI pass and **verified by me** before entering this table; the verification output is in §5b.*

**Progress against this table** (the table itself stays as the audit found it; each finding's detail section carries its own `Status:` line):

| Finding | Status | Commit |
|---|---|---|
| B1 | FIXED | `3252fb3` |
| B2 | FIXED | `49ffa87` |
| F1 | FIXED (+ follow-up) | `304915b`, `4ee844a` |
| B8 | FIXED (revised: warn → refuse) | `acfec7a`, `e3325ad` |
| B11, B12 | FIXED | `5237833` |
| `asc-4if` (NR3, answered) | FIXED | `bfb7786` |
| B4 | FIXED (3 sites; `registry.ts`/`schema.ts` not mutation-testable — see its Status) | `15947f8` |
| F4 (first half) | FIXED as a side effect of `asc-4if`; residual divergence untouched | `bfb7786` |
| F4-data | ANSWERED — 83 stores scanned, 4 ambiguous, all this audit's own probes: **no migration needed** | `15947f8` |
| `asc-51t` (not a hunt finding — the OPEN-path sibling of B4) | FIXED, and its inferred cause refuted. See §5c | this commit |

**A note on the bead IDs, because they do not match this report's B-numbers.** The beads were created in triage order (`asc-bcv.1` … `asc-bcv.21`), so `asc-bcv.<n>` is *not* finding `B<n>`. B8 is **`asc-bcv.4`**; `asc-bcv.8` is B3 (non-ASCII search). I committed B8 naming `asc-bcv.8` and corrected it in `acfec7a` — the first version of that message named a different, still-open finding. Mapping: B1→`.1`, B2→`.2`, F1→`.3`, B8→`.4`, B11→`.5`, B12→`.6`, B4→`.7`, B3→`.8`, B5→`.9`, B6→`.10`, B7→`.11`, B9→`.12`, B10→`.13`, F2→`.14`.

---

## 4. Fix Plan & Interactions

Act on this section first.

**Proposed phasing** (built from the sets and constraints below, not from file proximity):

| Phase | Findings | Why together |
|---|---|---|
| 1 | **B1, B2, F1** | The two Critical false-greens and the guard that protects future store work. All S-effort, single-file, no migration. |
| 2 | **B8, B11, B12** | The CLI-silence cluster: work accepted or refused with the wrong message. B11+B12 live in the same command. |
| 3 | **B4** (+ F4-data) | One transaction-mode change. It does **not** close `registerType`'s check-then-act — see the corrected note below. |
| 4 | **B3, B5, B6, B7, B9, B10** | Independent, each with its own empirical re-test; no shared migration, so they can be committed one at a time. |
| 5 | **F2, F3, F5, F6, F7, F8, F9** | The ones carrying a design or data decision. |

**`--across` is one unit of work, not four.** It now carries four separate defects — **F2** (the `SQLITE_MAX_ATTACHED` ceiling), **B11** (the `temp`/`main` alias collision), **B12** (a `--help` example that cannot work), and F2's sibling in `union.ts:38-43` (the "attach one at a time" workaround). It is the least-tested surface in the repository. Phase 2 takes the two that are pure defect (B11, B12); Phase 5 takes the two that need a design answer (F2 and its `union.ts` sibling).

**Ship-together sets (never split across phases):**

- **{B4, F4-data}** — **CORRECTED 2026-09-12, and the correction matters.** This note claimed *"`BEGIN IMMEDIATE` (B4) also removes the check-then-act window in `registerType`'s version selection. Do not fix the version-selection race separately; the transaction mode is the fix. My probe reached the snapshot guard before the UNIQUE constraint, so the UNIQUE collision remains **unverified** — fixing B4 may make it unreachable, and that should be confirmed by re-running the two-connection probe, not assumed."* The instruction to confirm rather than assume was followed, and it overturned the claim: the version read at `registry.ts:354` precedes the `BEGIN` at `:439`, so no transaction mode can cover it, and the two-process probe reproduced the collision **10 times in 10 trials**. **B4 did not close the race; `asc-odh` tracks it separately.** The full refutation, with the mechanism and the measurement, is in §9 R-F4. The reason the original note is left standing above rather than deleted is that it is the thing that was wrong, and the useful part is *which* assumption failed — "a lock taken anywhere in the function covers the whole function" — not the corrected sentence alone.
- **{B1, F5}** — **WITHDRAWN as a ships-with set: not a pair.** This report originally grouped them as "a name the guard vocabulary does not cover reaches a layer that assumes it does," and proposed extending `reservedPropertyName` once so both consumers use one list. Building B1 disproved that, and it is recorded here rather than quietly dropped. B1's mechanism was never a missing reserved name: the defect was that the property accumulator **was an object literal**, so `Object.prototype` members were reachable as values, and the fix is "stop using the prototype chain as a map" — `Object.hasOwn` for the read, a null-prototype map for the write. `constructor` is a *legitimate* property name, now working end to end (registered, refused when undecided, accepted as N/A, stored measured, projected into the view). F5's `a.b` is a different mechanism entirely: a name containing a dot becomes a JSON *path* in `json_extract(properties_json, '$.a.b')`, so the projection reads into a nested object that was never written. That needs `assertProjectable`, not a reserved-name entry — and adding `a.b` (or `constructor`) to `reservedPropertyName` would refuse a name the store can actually store. **B1 and F5 are standalone.** Shipping B1 as a pair with F5 would have meant either banning `constructor` or leaving B1 unfixed.
- **{F3, B9}** — both are "a write path accepts a value the read path cannot interpret." Both are fixed by making the write path validate, and both need the *same* decision about existing bad rows.

**Ordering constraints:**

1. **B1 before B2.** B2's fix changes what the tool tells a user to do; while B1 is live, the *correct* advice for a `constructor`-named required property (`--na constructor`) is **refused** by the tool. Fixing B2's wording without B1 produces advice that does not work.
2. **B5 before F2.** If `asc query` is to keep its read-only allowlist grant, B5 must be fixed first — otherwise `--across` (F2) is reading N stores, each of which may have been written by a newer ascend, with no guard on any of them.
3. **F1 before any future store work.** The guard that is supposed to catch a second entry-write path is currently evadable. It is cheap to fix and it protects work that has not been written yet.

**Fixes deferred to design work:**

- **B2 (wording half)** — the mechanical half (the placeholder must not be storable) is shippable; the message wording is a product decision, because the honest message has to say "we cannot invent a value for you", and the current design has no shape for that.
- **F3 (data half)** — the write-side fix is one line; deciding what to do about rows that already hold non-canonical keys is a migration decision.
- **F7** — trimming is the obvious fix and it is wrong: trimming changes the hash of a spec already stored as `" ms "`, so its `type_hash` would no longer match a re-registration and a new version would be minted. **Rejecting** whitespace never changes an existing hash. Prefer rejection.

**A shared migration:** F3 and B9 both need one pass over `entries`/`entry_types` if existing bad rows are to be repaired. Neither requires one to be *correct going forward*, so both can ship write-side-only and record the data half as a decision.

---

## 5. Detailed Findings

### B1 — A required property named `constructor` records as `measured` when it was never provided

**Lens:** 1 (assumption audit), 8 (cross-implementation divergence)
**Confidence:** Confirmed (empirical) · **Urgency:** Critical

**Assumption violated:** "if the property was not offered, its state is `not_measured`."

**Mechanism — one line.** `packages/core/src/state.ts:147-151`:

```ts
const states: Record<string, PropertyState> = {};
  if (property.name in properties) states[property.name] = 'measured';
```

`properties` is a plain object literal (`state.ts:87`). `in` walks the prototype chain, and `'constructor' in {}` is **`true`** in JavaScript. So for a property named `constructor`, line 149 assigns `'measured'` even though the caller offered nothing.

Nothing else catches it: `canonicalName('constructor')` → `'constructor'` (unchanged); `reservedPropertyName('constructor')` → `undefined`; `assertProjectable` (store) consults the same vocabulary, so it also misses it; and the required-property check at `state.ts:174` (`if (states[property.name] !== 'not_measured') continue`) reads the wrong value and passes.

**Evidence — through the real store write path:**

```
G1 register :: {"name":"ctor","version":1,...,"outcome":"created","bump":"major"}
G2 recordEntry(no constructor) :: {"entry":{...,"properties":{"real":"yes"},"na":[],
   "states":{"constructor":"measured","real":"measured"},...}}
G3 stored row :: [{"properties_json":"{\"real\":\"yes\"}","na_json":"[]"}]
G4 json_extract :: [{"c":null,"r":"yes"}]
```

The entry's own `states` says `constructor` was **measured**. The stored data has **no key** for it, and `json_extract(properties_json,'$.constructor')` is **null**.

**And the truthful recording is refused.** Marking it explicitly N/A is the documented correct action — `state.ts:179-181` literally advertises `--na` for this case — and it fails:

```
validateEntry {real:"yes"}                     :: ok=true,  states {"constructor":"measured","real":"measured"}
validateEntry {real:"yes", na:["constructor"]}  :: ok=false, "'constructor' is both measured and listed as not applicable"
```

So for this property name the user has **no way to record the truth**: the only accepted recording claims a measurement that does not exist.

**Consequence:** this is the false-green class. `states` is what `recordEntry` returns and what the read path reports, so a coverage statistic built on it counts a measurement that the data does not contain — while a query over the view reports `null` for the same property. Two surfaces of the same row disagree, and the one that says "measured" is the one the caller reads.

**Blast radius:** code — `packages/core/src/state.ts` (fix) + `packages/core/src/spec.ts` (reserved vocabulary); data — **none**; coordination — none.
**Verified fix (passes all eight checks):** use `Object.hasOwn(properties, property.name)` at `state.ts:149` instead of `in`, and change the accumulator at `:147` to `Object.create(null)` so no inherited key can ever be read. **Existing-data check (3):** no migration — the fix repairs the *read* of existing rows, and no row is rewritten. **Interaction (6):** shipping the reserved-name extension alone would refuse new `constructor` properties but leave rows already written reporting `measured`; ship both halves.
**Second line (cheap):** add `constructor` and the rest of `Object.prototype`'s keys to `reservedPropertyName`'s vocabulary so an author is refused at define time with a rename suggestion, exactly as `source` already is.

---

### B2 — The tool's own suggested command stores a fabricated measurement

**Lens:** 3 (boundary), 9 (write/read asymmetry)
**Confidence:** Confirmed (empirical) · **Urgency:** Critical

**The project's cardinal rule.** `TASKS.md` #7: *"**Omitted, never fabricated.** When a value does not exist, omit it. Never write `0` for unknown."*

**Mechanism.** `packages/core/src/state.ts:68-70` builds the suggested command by interpolating an example value unquoted:

```ts
function recordCommand(spec: TypeSpec, property: string, value: string): string {
  return `asc record ${spec.name} --prop=${property}=${value}`;
}
```

and `state.ts:178-181` uses it for a required property with no decision recorded:

```ts
`Record: ${recordCommand(spec, property.name, exampleValue(property))}, ` +
`or: asc record ${spec.name} --na ${property.name}`,
```

`exampleValue` (`core/src/schema.ts:169`) returns a literal `<string>` / `<number>` / `<json>` placeholder.

**Evidence — the tool's own output, then running it verbatim:**

```
$ asc record pair --prop=given=ok
 ›   Error: 1 problem(s) with this pair entry, so nothing was recorded:
 ›     missing: 'missing' is required and has no decision recorded
 ›       Required means a value OR an explicit N/A -- not necessarily a value.
 ›   Record: asc record pair --prop=missing=<string>, or: asc record pair --na
 ›   missing

$ asc record pair --prop=given=ok --prop=missing='<string>'
exit=0
$ asc query "SELECT json_extract(properties_json,'$.missing') AS missing FROM entries" --json
{"ascend_output":1,"rows":[{"missing":"<string>"}],"row_count":1}
```

**The suggested command succeeds and writes the literal text `<string>` into the ledger as the value of a required property.** For `string`, `text`, `ref` and `enum` the placeholder passes validation; for `number`, `integer`, `boolean` and `json` it fails (measured for all seven):

```
string   :: exampleValue="<string>"  | stored-and-valid=true
text     :: exampleValue="<text>"    | stored-and-valid=true
ref      :: exampleValue="<ref>"     | stored-and-valid=true
number   :: exampleValue="<number>"  | stored-and-valid=false
integer  :: exampleValue="<integer>" | stored-and-valid=false
boolean  :: exampleValue="<boolean>" | stored-and-valid=false
json     :: exampleValue="<json>"    | stored-and-valid=false
enum     :: exampleValue="x"         | stored-and-valid=true
```

So the same mechanism produces both failure modes: for four types it advises a command that **fails**, and for four it advises a command that **fabricates**. The `--na` alternative it prints alongside is the correct action.

**Consequence:** entries are immutable and cannot be deleted (`recordEntry` refuses a duplicate id; `entry_types_cannot_be_deleted`). A fabricated value recorded by following the tool's own instruction is **permanent**, and indistinguishable in the ledger from a real measurement.

**Blast radius:** code — `packages/core/src/schema.ts` (or `state.ts`); data — none (the fix prevents new bad rows); coordination — none.
**Verified fix:** make the placeholder un-storable for **every** type — `exampleValue` should return a value that `propertySchema(property).safeParse(...)` rejects — and reword the message to lead with the honest option. **Failure mode (5):** a rejected placeholder converts B2 into "the tool suggests a command that fails", which is the lesser defect but still a defect, so the wording must not present it as runnable. **Empirical re-test (8):** re-run the two commands above and assert the second exits non-zero.
**Requires design work:** the wording. The honest message has to say *"we cannot invent a value"*, and the current message shape has no room for that — see §4 for why B1 must land first.

---

### B3 — Non-ASCII full-text search silently returns nothing

**Lens:** 3 (boundary), 8 (cross-implementation divergence)
**Confidence:** Confirmed (empirical) · **Urgency:** High

**Mechanism.** The FTS index is `entries_fts(evidence_text, entry_id, tokenize='trigram')` (`store/src/schema.ts:287-291`). The trigram tokenizer indexes non-ASCII text correctly. The **query builder** does not: `toFtsMatch` (`store/src/search.ts:62`) tokenizes with

```ts
const tokens = (query.match(/[A-Za-z0-9_]+/g) ?? []).filter(
  (token) => token.length >= MIN_TERM_LENGTH,
);
```

`[A-Za-z0-9_]` is ASCII-only. A query consisting solely of non-ASCII characters yields zero tokens, so the function returns `null` and `searchEntries` (`search.ts:100-101`) returns `[]`.

**Evidence — the terms are in the index, and the query cannot ask for them:**

```
2 "ошибка"   :: raw MATCH -> ["e0"] | toFtsMatch=null | searchEntries -> 0 hits
2 "日本語"    :: raw MATCH -> ["e1"] | toFtsMatch=null | searchEntries -> 0 hits
2 "таймаута" :: raw MATCH -> ["e0"] | toFtsMatch=null | searchEntries -> 0 hits
2 "cafe"     :: raw MATCH -> ["e2"] | toFtsMatch="\"cafe\"" | searchEntries -> 1 hits
```

Raw `MATCH` against the real index **finds** every one of them. The builder returns `null`, so the shipping path returns zero.

**This is the failure the module itself names as the worse one.** `search.ts:13-18`: *"That trades a crash for a silent zero-result, which EV-fts measured as the worse of the two failures: a query that returns nothing is indistinguishable from 'no such entry exists', and ascend exists to answer questions about a corpus that DOES have the answer."* The module's own reasoning condemns the behaviour it ships for any non-ASCII query.

**Blast radius:** code — `packages/store/src/search.ts` (1 file); data — none; coordination — none.
**Verified fix:** widen the token class to Unicode letters/digits — `query.match(/[\p{L}\p{N}_]+/gu)`. **Boundary check (1):** keep `MIN_TERM_LENGTH = 3` (`search.ts:36`); the trigram tokenizer cannot match a 2-character term, so a 2-character CJK query must still degrade to the empty result rather than to an invalid query. **Mirror path (2):** the index already holds the terms — measured above; there is no write-side change. **Empirical re-test (8):** re-run the four queries and assert all four return ≥ 1 hit.

---

### B4 — Concurrent writers fail `database is locked` in 0–1 ms despite WAL and a 5 s busy timeout

**Lens:** 6 (time & concurrency)
**Confidence:** Confirmed (empirical) · **Urgency:** High

**The claim in the code.** `packages/store/src/db.ts:289-292`:

> `BEGIN` rather than `BEGIN IMMEDIATE`: this is a writer, but the lock is taken by the first write inside `body` regardless, and the store is opened with a busy timeout **precisely so a concurrent writer waits rather than fails**.

`db.ts:11-13` states the guarantee the design exists for: *"If it silently stays `delete`, concurrent subagent writes hit 'database is locked' instead of serialising."*

**The mechanism that falsifies it.** A **deferred** `BEGIN` takes no lock. The read inside the transaction establishes a WAL read snapshot. If another connection commits after that snapshot, the transaction's first **write** cannot be applied to a stale snapshot, and SQLite returns `SQLITE_BUSY_SNAPSHOT` (extended code **517**) **without consulting the busy handler** — retrying could not help, so the timeout is not consulted at all. `recordEntry` reads before it writes: `store/src/recorder.ts:261` (`SELECT id FROM entries WHERE id = ?`) and `:344/:349` (the type row) both precede the `INSERT` at `:268`. `packages/cli/src/commands/record.ts:364` wraps the whole thing in `withTransaction`.

**Evidence — the real path, two connections, busy timeout 5000:**

```
1a journal_mode                 :: {"journal_mode":"wal"}
1b busy_timeout                 :: {"timeout":5000}
1c read-then-write across a concurrent commit :: Error: database is locked errcode=517  after 0ms
1d store.withTransaction(read then write)     :: Error: database is locked errcode=517  after 1ms
```

One millisecond. Not five seconds. The timeout is configured, read back as `5000`, and never invoked.

**Consequence:** the scenario the code names as the reason for WAL — *concurrent subagent writers* — is exactly the one that fails, and it fails instantly with a message that suggests waiting would help. No data is lost (nothing is written) and a retry succeeds, so this is a hard failure rather than corruption.

**Blast radius:** code — `packages/store/src/db.ts` (fix) + `packages/store/src/registry.ts:199` (the same transaction helper, so the version-selection race goes with it); data — none; coordination — none.
**Verified fix as reported:** `BEGIN IMMEDIATE` for the store's own write transactions (`withTransaction` and `withRollback`, `db.ts:289-302`). **Caller contract (7):** this changes *when* a concurrent writer blocks — at `BEGIN` rather than at the first write — which is the point, because the busy timeout then applies. **Interaction (6):** the report claimed it also closes `registerType`'s check-then-act version selection; see §9 (R-F4). **That claim is refuted** — see the Status below. **Empirical re-test (8):** re-run probes 1c/1d and assert no `errcode=517`.
**Note on the comment:** the comment must change with the code. It currently records a reason that measurement refutes, which is how the defect survived review.

**Status: FIXED (`db.ts`, `registry.ts:439`, `schema.ts:405`).**

Three sites issued a deferred `BEGIN`, not one, and all three were changed. `db.ts`'s `inOwnTransaction` is the one the finding names and the one the probe drives: it is the shared half of `withTransaction` and `withRollback`. `registry.ts` was named by the Fix Plan. `schema.ts`'s per-migration loop was not named anywhere — it is the same defect class (`BEGIN` + a body that reads `sqlite_master` before it writes), so it moved with them rather than being left as a latent instance of the thing this fix exists for. Each site's comment now states its own mechanism and its own evidence, and `db.ts`'s false one is replaced by the measurement that refuted it.

- **Check 1 (the fix's own arithmetic).** Nothing counts anything; the change is one token and an end-state assertion. The test's boundary is the busy timeout: the second connection is given **50 ms** and must *block for it and then throw*, which distinguishes "waited and lost" from "never waited".
- **Check 2 (mirror path).** `withRollback` is the same helper (`inOwnTransaction`), so the preview path moved with the commit path — otherwise `--dry-run` would still take its snapshot late and a dry run could 517 where the real run does not, which is the preview lying about the run.
- **Check 3 (existing data).** None. No stored row changes meaning; nothing is migrated. The change is *when* a lock is taken, not what is written.
- **Check 5 (failure modes).** The failure mode moves in the caller's favour: a concurrent writer now **waits** (up to `busy_timeout`, 5 s by default) instead of failing in 1 ms with a message that implies waiting would help. That is the whole of the contract change.
- **Check 7 (caller contract).** No return value, no throw and no resolution order changes. A caller that could complete before can still complete; a caller that used to fail instantly now blocks. No caller is newly broken by waiting, and `record.ts`'s batch semantics are untouched — a batch that loses the lock still rolls back entirely and exits 1.
- **Check 8 (empirical re-test).** Met, both directions. `/tmp/probe-b4.mjs` drives the real `withTransaction` from `packages/store/dist` against a raw second connection, `busy_timeout` 300 ms. **Before:** `FAILED -- database is locked`, `elapsed :: 1ms`, verdict *"refused in 1ms, far below the 300ms timeout -- the handler was never consulted"*. **After:** `OK -- our transaction committed`, `elapsed :: 358ms`, and the other connection's own report is `the other connection was refused: database is locked (after 358ms)` — it waited out its own timeout against the write lock we now hold from `BEGIN`.
- **Check 6 (interaction).** The report's interaction claim — that this also closes `registerType`'s check-then-act version selection — is **refuted, by reading and then by measurement.** See R-F4 in §9: the version read at `registry.ts:354` precedes the `BEGIN` at `:439`, so the transaction mode cannot cover it, and a two-process probe reproduced the collision **10 times in 10 trials**.

**Mutation-tested.** Reverting `db.ts` to `db.exec('BEGIN')` kills exactly one test — the new one — and the failure message is the mechanism itself: `expected [Function] to throw an error`, i.e. the concurrent write *succeeded* instead of blocking. Restored byte-identical (`shasum -a 256` → `2eb94e07…`).

**The two other sites are NOT mutation-tested, and the limitation is stated rather than smoothed over.** Reverting `registry.ts` and `schema.ts` to `BEGIN` kills **nothing**: 96 tests in `registry`/`schema`/`views` pass either way. That is not a gap in the tests — it is that both defects are unreproducible by a two-connection probe. At `db.ts` the gap between the read and the write is a **JS-level** gap (`body()` runs between them), which a probe can interleave into, and did. At `registry.ts` and `schema.ts` the read and the write are both inside **one `db.exec`**, so no probe can land between them; the change there is the same one token for the same mechanism, verified by reading and covered for behaviour preservation, but **the concurrency defect at those two sites was not independently reproduced**. This is recorded because F9 in this same report is *a comment asserting a cleanup guarantee the code does not provide*, and the reason it is worth reporting is that it is how B4 survived review.

---

### B5 — A read-only open skips the ahead-of-build guard

**Lens:** 2 (state machine), 8 (cross-implementation divergence)
**Confidence:** Confirmed (empirical) · **Urgency:** High

**Mechanism.** `openStore` refuses a store whose `user_version` is **ahead** of the running build (`NewerSchemaError`) on the writable path. The `readOnly: true` path (`db.ts:52-68`) skips migrations — correctly — but the probe shows it also skips the refusal.

**Evidence:**

```
4a writable open of a v99 store :: THREW NewerSchemaError: ...
4b read-only open               :: SUCCEEDED -- migrations={"from":99,"to":99,"applied":[]}
4c   and it reads               :: {"n":0}
```

**Why this matters more than it looks.** `db.ts:37-48` documents read-only existence as the reason `Bash(asc query:*)` is a *defensible settings.json allowlist entry* — the permission is granted because the command has been shown unable to mutate. So the read-only path is the one that gets pointed at other people's stores, and it is the one with no schema guard. `db.ts:66-68` states the intent for the *behind* case — *"a store that is behind is refused rather than queried -- see `StaleStoreError`"* — and the ahead case has no equivalent on this path.

**Consequence:** `asc query` reads a store written by a newer ascend and presents whatever rows exist under the running version's interpretation of the schema. That is the "reports a plausible wrong number" failure the project treats as severity-zero.

**Blast radius:** code — `packages/store/src/db.ts` (1 file); data — none; coordination — none (single-version guarantee per store).
**Verified fix:** perform the same `user_version > SCHEMA_VERSION` check on the read-only path and throw `NewerSchemaError`, whose message already names the fix (upgrade ascend). **Mirror path (2):** the check must exist on both opens; extract it so they cannot drift. **Caller contract (7):** `asc query` would begin refusing ahead stores — which is the stated intent, not a regression.
**Ship before F2** — see §4.

---

### B6 — `asc init` in a repository subdirectory leaves the store un-ignored

**Lens:** 1 (assumption audit), 7 (environment divergence)
**Confidence:** Confirmed (empirical) · **Urgency:** High

**Assumption violated:** "the project root is where `.gitignore` lives."

**Evidence:**

```
$ cd $T/packages/api && asc init
init exit=0
subdir .gitignore: ABSENT
check-ignore exit=1 (1 = NOT ignored)
$ git -C $T status --porcelain
?? packages/
```

`asc init` exits **0** and reports success; nothing names a `.gitignore`; `packages/api/.ascend/ascend.db` is not ignored, and the whole subtree shows as untracked — one `git add -A` from being committed.

**Consequence:** `ascend.db` is exactly the kind of file that should never be committed: it is a per-project store whose entries can carry `evidence_text` derived from real transcripts. A monorepo package is a legitimate place to run `asc` (asc records per project), so the trigger needs no unusual setup.

**Blast radius:** code — `packages/cli/src/commands/init.ts` (1 file); data — none; coordination — none.
**Verified fix:** write the ignore entry **next to the store it protects** — i.e. in the directory the store is created in — rather than assuming a repo root, and report the path written. **Existing-data check (3):** a store already created un-ignored is not repaired by the patch; `asc doctor` (or `init`) should *report* an un-ignored existing store when it finds one. **Failure mode (5):** if no `.gitignore` exists in that directory, create one; if the directory is not in a git repo at all, say so rather than writing a file that does nothing.

---

### B7 — `asc init` replaces a symlinked `.gitignore` with a regular file

**Lens:** 7 (environment divergence)
**Confidence:** Confirmed (empirical) · **Urgency:** Medium

**Evidence:**

```
init exit=0  isSymlinkAfter=false
before: node_modules//*.log/
after:  node_modules//*.log/.ascend//
shared target now: node_modules//*.log/
```

**Contents are preserved** — `init` read through the link, appended `.ascend/`, and wrote the combined text. That correction matters: an earlier draft of this finding implied content loss, and the measurement refutes it.

The link is not preserved. `.gitignore` is now a regular file, and the shared target still holds only the original two lines. The two files now **diverge permanently and silently**: future edits to `shared.txt` no longer reach this repository.

**Consequence:** a repository that deliberately shares one `.gitignore` across several repos quietly stops sharing it, with no message.

**Blast radius:** code — `packages/cli/src/commands/init.ts` (1 file); data — **the broken link is not repairable automatically** (after the write, the original target path is unrecoverable from the file); coordination — none.
**Verified fix:** resolve the path with `realpathSync` **once** and use that resolved path for both the read and the write, so the append goes through the link. **Mirror path (2):** the read and the write must use the same resolution. **Existing-data check (3):** forward-only — state this in the fix, and have the command report when the target was a symlink so a user who has already run it knows to check.

---

### B8 — Duplicate `--prop` silently drops the first value

**Lens:** 1 (assumption audit), 3 (boundary)
**Confidence:** Confirmed (empirical) · **Urgency:** High

**Evidence:**

```
define exit=0
record exit=0    stderr: (empty)
$ asc query "SELECT json_extract(properties_json,'$.chosen') AS chosen FROM entries" --json
{"ascend_output":1,"rows":[{"chosen":"b"}],"row_count":1}
```

Given `--prop=chosen=a --prop=other=x --prop=chosen=b`, the ledger holds `"b"` and **nothing was printed to stderr**. `a` is gone.

**Consequence:** the caller's first value is discarded with no signal, into an **immutable** ledger — entries cannot be deleted or corrected (`recordEntry` refuses a duplicate id; `recordEntry`'s doc explains the residue is permanent). The CLI has a working warnings channel and uses it elsewhere; the store's own precedent (`state.ts:88-96`) is *"Stripped rather than rejected: a stripped key is recoverable and visible, a rejected entry is lost work. Stripping is reported so it cannot be silent."* This path violates that precedent.

**Blast radius:** code — `packages/cli/src/commands/record.ts` (1 file); data — none; coordination — none.
**Verified fix as reported:** detect the repeat while accumulating `--prop`, and emit a warning on the existing channel naming both values and which one won — consistent with `state.ts:88-96`. **Failure mode (5):** the report noted that *"refusing outright (exit 2) is also defensible and is stricter; the project's own precedent favours warn-and-keep, so that is the recommendation."*

**Status: FIXED, in two phases — the escalation was taken.** The warning shipped first (`acfec7a`), then you answered the shared `asc-4if` question with **"refuse the collision"** and noted B8 is the same class, so the refusal supersedes it. Both phases are recorded because the first one's reasoning is what the second one overruled, and the overrule was on a stated ground rather than a change of mind.

*Phase 1 — warn and name the winner (`acfec7a`).* `sameValue`, `PropertyFlags`, `propertiesFrom`, `overruledWarning`; six tests. The warning fired on stderr and rode the row's `warnings` array, so a machine reading only stdout saw it too.

*Phase 2 — refuse (`packages/cli/src/commands/record.ts`: `PropOccurrence`, `sameValue`, `propertiesFrom`, `repeatedPropertyError`); seven tests, four of them new.* Why the warning was not enough, in the terms the fix itself uses: the warned run still produced a row **whose contents the caller did not choose**, and nothing in that row distinguishes it afterwards from one where `b` was meant all along. `--prop` is where an LLM workflow records what it observed, and that caller reads stdout and may never look at stderr. A conflict resolved by silently picking a winner is refused — the same branch `asc-4if` took for the fold collision one spec over.

- **Check 1 (the fix's own arithmetic).** Nothing counts anything — the comparison is `canonicalJson(left) === canonicalJson(right)`, so `{"a":1,"b":2}` and `{"b":2,"a":1}` are one value. `canonicalJson` **throws** on a non-finite number (`core/src/hash.ts:186`; measured: `JSON.parse('1e999')` really yields `Infinity`), so the uncomparable case needs a direction — **and the direction FLIPPED with the escalation.** "Cannot compare" meant *different* while this fed a warning, on the grounds that a spurious warning is the smaller failure. As a refusal that same choice refuses a legitimate command, and refuses it with a message quoting two **identical** values as different: a false report, the class this project treats as severity-zero. The text is now the tiebreak (`left.text === right.text`), which is sound rather than a fudge — `flagValue` is deterministic, so one text parses to one value.
- **Check 2 (mirror path).** Grouped by the name **as written**, which is what the store does too — measured: `--prop=Chosen=b` against a type declaring `chosen` is dropped as *"'Chosen' is not a property of decision"*, **not** folded onto `chosen`. So the CLI's notion of "the same name" is the store's, and there is no fold-collision to detect on this path. A repeat with the **same** value is still not a conflict: nothing conflicted, and `--na` already treats a repeat as a set — a refusal that fires when nothing conflicted rejects legitimate work, which is worse than the noise it replaced.
- **Check 3 (existing data).** None needed either phase: neither changes what is written, only whether it is written. No stored row becomes wrong, and no migration applies.
- **Check 5 (failure modes).** The refusal is raised **before any store work** — before `withProject`, before validation, before the transaction. The conflict is entirely inside the caller's own argv, so no store state can resolve it and no validation error the caller may also have is the more useful thing to report first. A `--dry-run` reaches the refusal too, and must: previewing a recording that cannot happen is its own false report. Exit **2**, not 1 — the same class as a malformed `--prop`, which already exits 2.
- **Check 8 (empirical re-test).** Met on the real binary: exit 2, the ledger holds 0 entries, `--dry-run` exits 2 as well. The negative controls hold too — a same-value repeat still records (exit 0, `chosen` measured), and a reordered-key `json` repeat still records.

**Mutation-tested, five mutations and all five killed:** the refusal removed (kills 4), the uncomparable pair counting as different again (kills 1), raw text instead of canonical value (kills 1), any repeat counting as a conflict (kills 1), and the refusal **relocated after validation** (kills the placement test). Harness: `/tmp/mutate-b8-refusal.mjs`, restored byte-identical. The placement mutation needs two edits rather than one — a relocation is the only thing that tests a placement claim, and a one-line tweak cannot express it.

**What this fix does NOT settle.** The report's own corroboration at §5b stands: `asc record` refuses document-plus-`--prop` on the grounds that *"merging them would mean choosing a winner per property -- a rule nobody could predict"*, yet chose a winner here. Refusing makes the two paths consistent at last. The rule is now: **a conflict between two declarations of one name is refused, never resolved.**

---

### B9 — A `json` property accepts a `Date`, marks it `measured`, and stores `{}`

**Lens:** 8 (cross-implementation divergence), 9 (write/read asymmetry)
**Confidence:** Confirmed (empirical) · **Urgency:** Medium

**Mechanism.** Validation and serialization are two different implementations of one invariant. `propertySchema` for `json` accepts anything; `canonicalJson` is what actually decides whether a value can be stored.

**Evidence:**

```
json date :: validate={"ok":true,"errors":[],"states":{"v":"measured"}} | canonicalJson="{\"v\":[{}]}"
json nan  :: validate={"ok":true,...,"states":{"v":"measured"}} | canonicalJson={"__threw":"TypeError: cannot canonically serialize the non-finite number NaN"}
json fn   :: validate={"ok":true,...,"states":{"v":"measured"}} | canonicalJson={"__threw":"TypeError: cannot canonically serialize a function"}
```

The loud cases are **guarded** — `canonicalJson` refuses NaN, Infinity, `undefined`, bigint, function and symbol with a message that names the kind (§6, G8). The `Date` case is not: it serializes to `{}`, validates `true`, and is recorded `measured`. **Silent data loss with a "measured" state** — the same false-green shape as B1.

**Reachability, stated honestly:** a `Date` cannot arrive through `asc record` (the input is JSON text, which has no date type). It is reachable through the **library API** — which the user listed as a shipping runtime — and through any future adapter that builds a properties object in process.

**Blast radius:** code — `packages/core/src/schema.ts` (or `core/src/json.ts`); data — none reachable through the CLI; coordination — none.
**Verified fix:** have `validateEntry`'s value path round-trip through the same serializer the writer uses, so validation and storage cannot disagree — which also converts the four loud late throws into early, actionable validation errors. **Failure mode (5):** must not turn the existing loud refusals into silent passes; assert on all six unserializable kinds plus `Date`. **Interaction (6):** shares a decision with F3 about existing rows.

---

### B10 — `types export` on an empty registry emits 0 bytes, and importing it fails

**Lens:** 4 (data lifecycle), 5 (error path)
**Confidence:** Confirmed (empirical) · **Urgency:** Medium

**Evidence:**

```
types export                        :: exit=0  stdout_bytes=0
types import -  (that output)      :: exit=1  standard input is not valid JSON: Unexpected end of JSON input.
printf '[]' | types import -       :: exit=0  (header-only table)
printf '[]' | types record probe -  :: exit=1  (the "caller that produced nothing" message)
```

Three representations of "nothing": zero bytes, `[]`, and a refusal. `export` emits the one its own `import` rejects.

**Consequence:** a backup/restore or cross-project transfer script — the reason `export`/`import` exist — breaks on the empty case, and the failure surfaces at restore time rather than backup time. The `record`/`import` asymmetry is defensible on its own (one type vs zero types); the export→import round trip is not.

**Blast radius:** code — `packages/cli/src/commands/types/export.ts` + `import.ts`; data — none; coordination — none.
**Verified fix:** `export` emits `[]` for an empty registry. **Caller contract (7):** a consumer that already treats 0 bytes as "no types" must tolerate `[]`; that is a one-line change in the consumer and belongs in the fix's notes. **Empirical re-test (8):** `asc types export | asc types import -` must exit 0 in both directions on an empty registry.

---

### F1 — The single-write-path guard evades 4 of 6 write forms

**Status: FIXED** — `304915b`, with a follow-up at `4ee844a`. The evidence table below carries two corrections found while building the fix (see the postscript).

**Lens:** 3 (boundary), 8 (cross-implementation divergence)
**Confidence:** Confirmed (empirical) · **Urgency:** High

**What the guard is for.** `packages/store/src/recorder.ts:4-6`: *"This is the only module in ascend that INSERTs into `entries`. Nothing else may."* Enforced by a source scan in `packages/store/test/recorder.test.ts:578`:

```ts
const WRITE = /INSERT\s+INTO\s+entries\b/i;
```

applied **line by line** after comment stripping (`recorder.test.ts:571-576`).

**Evidence — the scan's own logic, run against six forms:**

```
scan plain                 :: CAUGHT
scan INSERT OR REPLACE     :: EVADES
scan REPLACE INTO          :: EVADES
scan INSERT OR IGNORE      :: EVADES
scan split over two lines  :: EVADES
scan block comment between :: CAUGHT   <-- corrected; see postscript
```

**Consequence:** the test's own comment states the threat it exists for — *"a second `INSERT INTO entries` compiles and passes every behavioural test in this file"*. A second write path written as `INSERT OR REPLACE INTO entries` — which is the natural way to write an upsert — passes every behavioural test **and** the guard. This is the false-green class: a check that reports green while not checking.

**Blast radius:** code — `packages/store/test/recorder.test.ts` (1 file); data — none; coordination — none.
**Verified fix (as shipped):** `scan` now matches over the WHOLE comment-stripped source and derives each line number from the match offset, and the pattern covers all five SQLite conflict clauses, `REPLACE INTO`, quoted/bracketed identifiers, a schema qualifier, and comment text between the verb and the table:

```
\b(?:INSERT(?:\s+OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK))?\s+INTO|REPLACE\s+INTO)\s+
(?:--[^\n]*\n\s*)*(?:["'\[]?\w+["'\]]?\s*\.\s*)?["'\[]?entries["'\]]?\b
```

**Boundary check (1):** the multi-line case is exactly why per-line matching fails — the fix must operate on the whole source. **Failure mode (5):** the widened pattern must still not fire on the string `"SELECT * FROM entries"` (asserted today at `recorder.test.ts:591`) nor on prose mentioning the token. **Empirical re-test (8):** add all six forms to the test's self-check block, which already exists at `recorder.test.ts:584-591` for exactly this reason.

**Postscript — two corrections found while building the fix, recorded rather than dropped.**

1. **The table's sixth row was wrong.** "Block comment between" is **CAUGHT** by the guard as written: stripping `/* c */` leaves `INSERT INTO  entries`, which the narrow pattern matches. Measured both ways. The count in the headline ("4 of 6") survives because a different form the report did not enumerate does evade — see (2) — so the row is a membership error, not a count error. A finding whose conclusion is right and whose evidence is wrong is still a defective finding, which is why this is written down.

2. **A seventh spelling evades, and the report omitted it:** `INSERT INTO "entries" (…)`. Measured. So the reachable set was larger than the report's enumeration, and the fix covers it.

3. **A note on the fix's own construction.** After 12 of 13 spellings were caught, the last miss was `INSERT INTO -- c\n entries`, and it is worth naming why: `stripComments` removes *JS* comments, and a `--` inside the SQL text is not one, so the pattern treated the comment as an obstacle `\s+` could not cross. Closed at `4ee844a`, with all three comment spellings now in the enumerated test. Also recorded there: the first draft's comment justified `(?!\w)` over `\b` as load-bearing, and a mutation run showed the two are equivalent at that position — so the comment now claims only what the tests actually protect.

---

### F2 — `--across` hits `SQLITE_MAX_ATTACHED` where the sibling implementation dodges it

**Lens:** 8 (cross-implementation divergence), 3 (boundary)
**Confidence:** Confirmed (empirical) · **Urgency:** Medium

**Two implementations of "query across projects".** `unionEntries` (`store/src/union.ts`) explicitly works around the limit — `union.ts:38-43` names *"the 'attach one at a time' workaround"*, implemented at `union.ts:359-367`. `asc query --across` does not use it: it calls `attachStore` per project in its own loop (`cli/src/commands/query.ts:24,400`).

**Evidence:**

```
10 projects exit=0
11 projects exit=1  Error: too many attached databases - max 10
```

**Consequence:** a hard wall at a round number with a raw SQLite message, in a path whose sibling already solved the problem. Ten projects is an ordinary monorepo. The guarded sibling is the specification: cite `union.ts:359-367`.

**Blast radius:** code — `cli/src/commands/query.ts` + `store/src/union.ts`; data — none; coordination — none.
**Verified fix:** route `--across` through `unionEntries`, or apply the same attach-one-at-a-time workaround. **Interaction (6):** `union.ts`'s approach must still satisfy the read-only guarantee documented at `db.ts:37-48` — verify, do not assume. **Ship after B5**, per §4. **Effort M** because the alias/qualification behaviour (`query.ts:116`) is a stated constraint.

---

### F3 — Per-property prose keys are stored verbatim while the contract says canonical

**Lens:** 9 (write/read asymmetry)
**Confidence:** Confirmed (empirical) for the write side; the display lookup is Traced · **Urgency:** Medium

**The contract.** `store/src/registry.ts:46-47`: *"Per-property prose, **keyed by canonical property name**."*

**The writers do not canonicalize.** Both of them copy the caller's keys verbatim:

```ts
// registry.ts:173-174 (toStorage) — spec-derived prose at :171 IS canonical (:170 property.name)
for (const [key, value] of Object.entries(options.prose ?? {})) {
  prose[key] = value;
}
```

```ts
// registry.ts:676-679 (updateTypeProse)
const nextProse = prose.propertyProse === undefined
  ? existing.prose
  : { ...existing.prose, ...prose.propertyProse };
```

**Evidence — stored key vs the spec's canonical name:**

```
stored prose_json = {"reviewKind": "..."}   while the spec property canonicalizes to 'review_kind'
```

The store's own reader looks up `review_kind`, finds nothing, and reports the prose as absent — while `prose_json` in the row holds it. Both writers (`toStorage`, `updateTypeProse`) are reachable from the CLI: `types define` and `types import` (`import.ts:31-32` documents prose-only updates that deliberately do not mint a version).

**Blast radius:** code — 2 files; data — **existing rows may already hold non-canonical keys**, and neither writer canonicalizes on read, so a repair pass is a separate decision; coordination — none.
**Verified fix (write side):** canonicalize keys through `canonicalName` in both writers, and refuse a key that canonicalizes to a name the spec does not declare (`canonicalName` maps `reviewKind` → `reviewkind`, not `review_kind`, so silently canonicalizing would still miss — the honest fix is to **reject** an unknown key with the declared names listed, matching the existing "not a property … so it was dropped" warning's wording at `state.ts:88-96`).
**Requires design work:** the read side. Deciding whether to reinterpret or discard already-stored non-canonical keys is a data decision — see §4.

---

### F4 — A duplicated property name registers with a warning, and the two enforcers disagree

**Lens:** 8 (cross-implementation divergence), 4 (data lifecycle)
**Confidence:** Confirmed (empirical) · **Urgency:** Medium

**Evidence — reachable through the real CLI:**

```
$ asc types define amb.json          # properties: k:string, k:number
name  version  major  outcome  bump
amb   1        1      created  major
 ›   Warning: properties 0 and 1 both canonicalize to 'k'

$ asc record amb --prop=k=5
 ›   Error: 1 problem(s) with this amb entry, so nothing was recorded:
 ›     k: Expected string, received number
```

The type is **registered** on a warning. And the two enforcers in `@ascend/core` disagree in **opposite** directions:

```
validateEntry {k:5}    :: ok=false, "Expected string, received number"   (FIRST declaration)
validateEntry {k:"s"}  :: ok=true
buildSchema   {k:5}    :: true                                           (LAST declaration)
buildSchema   {k:"s"}  :: false
```

So for one registered type, `validateEntry` refuses exactly what `buildSchema` accepts. `canonicalizeTypeSpec` reports no error, and both declarations survive into the stored spec (`[{"name":"k","type":"string"},{"name":"k","type":"number"}]`).

**Reachability of the divergence today:** `buildSchema` has **no production caller** — I grepped `packages/{core,store,cli}/src` and `packages/analysis/src` and found only `core/test/schema.test.ts` (which is why this is FRAGILE and not BUG). It is exported public API from `@ascend/core` and is the documented spec→zod builder, so the divergence goes live the moment any consumer — E5's adapter, `packages/analysis`, or a new CLI path — uses it.

**Blast radius:** code — `packages/core/src/spec.ts` (1 file); data — **types already registered with a duplicate cannot be deleted** (`entry_types_cannot_be_deleted`), so the fix cannot be retroactive; coordination — none.
**Verified fix:** make a duplicate property name an **ERROR** in `canonicalizeTypeSpec`, consistent with the empty-name rule that `asc-0w9` established (`core/test/spec.test.ts`: *"makes an empty canonical name an ERROR"*). **Existing-data check (3):** blocking new registrations does not invalidate existing ones, which keep working with the divergence — state that in the fix. **Empirical re-test (8):** re-run `asc types define` with the duplicate document and assert exit non-zero.

**Status: the FIRST HALF is FIXED, as a side effect — `asc-4if` (`bfb7786`). No separate F4 fix has been made.**

This finding's suggested fix was, verbatim, *"make a duplicate property name an ERROR in `canonicalizeTypeSpec`"*. `asc-4if` — a fold collision raised by a different lens, where two properties canonicalize to one name and the registry silently kept the last — took exactly that answer, on your instruction ("refuse the collision"), and its fix **is** this one: the collision moved from `canonical.warnings` to `canonical.errors`, and `registerType` refuses on non-empty `errors` before anything is written. Recorded as a side effect rather than as F4 work, because the two findings are the same defect reached from two directions and reporting it as a separate fix would double-count one change.

Re-tested on the real binary with F4's own document from the Evidence block above (`properties: k:string, k:number`):

```
$ asc types define /tmp/amb.json
 ›   Error: 1 problem(s) make 'amb' unusable, so nothing was registered:
 ›     properties 0 ('k') and 1 ('k') are the same name: both canonicalize to 'k', ...
exit=1        entry_types rows for 'amb': 0        v_amb* views: none
```

Exit 1, no row, no view — F4's check-8 assertion ("re-run `asc types define` with the duplicate document and assert exit non-zero") is met, and the two-enforcer divergence it describes can no longer be *reached* through the registry, because a spec that would diverge is now refused before it is stored.

**F4-data — the existing-data half — is ANSWERED 2026-09-12: no migration is needed, and the retroactive half is impossible by design.** The report left two questions: whether already-registered ambiguous types need a repair, and what to do about them. Measured by walking `$HOME` and `/tmp` for every `.ascend/` directory and opening each `ascend.db` **read-only**:

```
83 store(s) scanned, 4 ambiguous type version(s) total
  /tmp/e4rev.0nniZ0/.ascend/ascend.db  ::  foldclash   v1 dupe=review_kind
  /tmp/e4rev.KUdnrn/.ascend/ascend.db  ::  foldclash   v1 dupe=review_kind
  /tmp/e4rev.O62ZsH/.ascend/ascend.db  ::  fold_mixed  v1 dupe=review_kind
  /tmp/e4rev.eedx91/.ascend/ascend.db  ::  foldclash   v1 dupe=review_kind

/Users/<user>/projects/ascend/.ascend/ascend.db   6 version(s), 0 ambiguous
```

**83 stores, 4 ambiguous versions — and every one of the four is mine.** All four live in `/tmp/e4rev.*`, they are named `foldclash` and `fold_mixed`, and those are the throwaway probes this audit created to demonstrate `asc-4if`. **No store outside this audit holds one, and the repository's own store holds none of its six versions.** So there is nothing to migrate and no collision plan to write.

The retroactive half is impossible anyway, for the reason the report itself named: `entry_types_cannot_be_deleted` (G6) makes a registered version permanently un-removable, so an already-stored ambiguous spec could only ever be *deprecated*, never repaired. Since the real population is empty, that is a statement about the schema rather than a task.

Harness: `/tmp/scan-f4data.mjs` — read-only handles, no DML, and it reimplements `canonicalName` locally rather than importing it, so the scan cannot agree with the implementation it is checking. **Limit, stated:** it walks to depth 6 under `$HOME` and `/tmp` only, so a store elsewhere on this machine is not covered; and 83 stores on one developer's laptop is not a claim about any other machine — it is a claim that *this* population needs no migration, which is all the ships-with set needed.

**What F4's residual actually is.** Only the `validateEntry`-first vs `buildSchema`-last divergence, and it is unreachable through the registry — which is why the report rated F4 FRAGILE rather than BUG in the first place, and why the reason it gives (`buildSchema` has no production caller) still holds: it is reached only by `core/test/schema.test.ts`. **The divergence itself is untouched and unaddressed by this fix**, and it is stated here rather than implied to be closed: a `buildSchema` consumer added later would still disagree with `validateEntry` about a spec with a duplicate name — it is simply that no such spec can be registered any more.

---

### F5 — `assertProjectable` misses a dotted property name

**Lens:** 3 (boundary), 8 (cross-implementation divergence)
**Confidence:** Confirmed (empirical) · **Urgency:** Medium

**What the guard is for.** `store/src/views.ts:28-35` names its threat model explicitly: *"a spec that reached the store without passing the registry"* — a version row inserted by hand, or a store created before the rule existed. `views.ts:76-100` refuses on `reservedPropertyName`, then throws before any DDL runs.

**Evidence — three names refused, one passed:**

```
"source"  -> Error: cannot build a faithful view for these definitions (asc-865.1)
"id"      -> Error: cannot build a faithful view for these definitions (asc-865.1)
"x_state" -> Error: cannot build a faithful view for these definitions (asc-865.1)
"a.b"     -> {"type":"byhand","views":["v_byhand_v1"],"indexes":["idx_entries_byhand_a.b"]}
```

The reserved-name checks work. `a.b` is not a reserved *name*, so it passes — and the generated index and view embed it as a **JSON path**:

```
CREATE INDEX "idx_entries_byhand_a.b" ON entries (type_name, json_extract(properties_json, '$.a.b'))
```

`$.a.b` addresses field `b` of object `a`, not a key literally named `a.b`. Measured consequence:

```
properties_json          -> {"a.b":"the-value"}
view column "a.b"        -> {"v":null}
json_extract(...,'$.a.b') = 'the-value'  -> []
```

The value is in the ledger; the queryable surface says **NULL**; the index never matches. The module's own header calls this the thing it exists to prevent: *"Reporting it as `not_measured` would put rows into a coverage denominator for a question they were never asked, which is how a statistic reports a plausible wrong number."*

**Reachability, stated honestly:** `canonicalName('a.b')` → `'a_b'`, so `registerType` can never store a dotted name. This is reachable **only** through a spec that bypassed the registry — exactly the class the guard declares it exists for. It is a gap in a defense-in-depth guard, not an open door.

**Blast radius:** code — `packages/store/src/views.ts` (1 file); data — none (a dotted type can only exist where the registry was bypassed); coordination — none.
**Verified fix:** extend `assertProjectable` to refuse any property name that is not a safe JSON path segment — reject `.` and `"`. **Boundary check (1):** test `.` at position 0, in the middle, and at the end, plus `"` and a lone `$`. **Interaction (6):** sharing the vocabulary extension with B1's second line keeps one list; see §4. **Existing-data check (3):** a store that already holds a dotted type would then fail every future `refreshTypeViews` — that is the `asc-865.1` precedent (refuse and name the fix), so it is consistent, but state it.

---

### F6 — `indexName` collides, and the second index is silently never created

**Lens:** 8, 1
**Confidence:** Confirmed (empirical) · **Urgency:** Low

**Evidence:**

```
indexName('test','run_count') === indexName('test_run','count') === 'idx_entries_test_run_count'
```

Only one index is created; there is no index on the other property's path. Registering `type{time}` created nothing at all, because the schema's own `idx_entries_type_time` already occupies the name.

**Mechanism.** `views.ts:102-104` builds the name by joining with `_`. `ensurePropertyIndex` (`views.ts:127-134`) short-circuits on a name it already finds in `sqlite_master` and returns `false` — "already there" — so the missing index is never created, and `refreshTypeViews`'s report does not distinguish "already existed" from "never created because the name was taken."

**Consequence:** a silently missing index. A performance defect, not a wrong answer — I did not find a case where the collision changes a result.

**Blast radius:** code — `packages/store/src/views.ts` (1 file); data — **renaming leaves the old index in place** (`IF NOT EXISTS`, never dropped), so the fix is additive and benign; coordination — none.
**Verified fix:** make the name injective — append a short hash of the `(typeName, property)` pair. **Note:** no separator character can be safe here, because both operands draw from `[a-z0-9_]`; a hash (or a length prefix) is the only injective option. **Empirical re-test (8):** register both colliding pairs and assert two distinct indexes exist.

---

### F7 — `unit` is not trimmed, so `" ms "` forces a MAJOR bump

**Lens:** 3 (boundary), 9 (write/read asymmetry)
**Confidence:** Confirmed (empirical) · **Urgency:** Low

**Evidence:**

```
unit "ms" vs " ms " :: "ms" vs " ms " | hashEqual=false | bump=major
```

Names are canonicalized (`a.b` → `a_b`, `café` → `caf`); `unit` is copied through. The whitespace difference changes the type hash, and the diff classifies it as **`major`** — the most expensive bump, reserved for changes that invalidate stored entries — for a change that alters no meaning.

**Blast radius:** code — `packages/core/src/spec.ts` (1 file); data — **a spec already stored as `" ms "` has a hash that trimming would change**, minting a new version on re-registration; coordination — none.
**Verified fix — and the obvious fix is wrong:** do **not** trim. Trim changes the hash of an already-stored spec, and `entry_types`' composite FK keyed on `type_hash` (`schema.ts:53-58`) is what makes drift impossible. **Reject** leading/trailing whitespace as a definition error instead — a rejection never changes a hash that has already been computed and stored. **Empirical re-test (8):** assert `unit: " ms "` fails canonicalization with a legible error and that `unit: "ms"` is unaffected.

---

## 5b. Addendum — findings from the supplementary CLI pass

A second read-only lens pass covered `packages/cli` after the first hunt closed. Its four surviving candidates are below; **every one was re-verified by me** against the built CLI or the runtime, and the verification is quoted. Two of its claims did not survive and are in §8.

### B11 — A directory named `temp` breaks `--across`, and the comment says it cannot

**Lens:** 1 (assumption audit), 7 (environment divergence) · **Confidence:** Confirmed (empirical) · **Urgency:** Medium

**The comment claims the guard exists.** `cli/src/commands/query.ts:384-386`:

```ts
// Seeded from the connection rather than from an empty set, so a name SQLite already answers to
// -- `main`, `temp`, or anything a previous attachment took -- cannot be allocated.
const taken = new Set(databaseNames(handle));
```

`databaseNames` reads `PRAGMA database_list` (`store/src/union.ts:288-292`). That pragma **does not report `temp`** on a fresh connection — SQLite holds the temp database in `aDb[1]` but omits it while unused. So `taken` holds only `main`, `allocateAlias` hands out `temp`, and the second guard in `attachStore` (`union.ts:324`) uses the *same pragma* and misses it too. The ATTACH then reaches SQLite, which refuses it.

**Evidence — the mechanism, at the driver level:**

```
2a database_list        :: [{"seq":0,"name":"main","file":""}]
2b ATTACH AS temp       :: Error: database temp is already in use errcode=1
2c ATTACH AS Temp       :: Error: database Temp is already in use errcode=1
2d ATTACH AS main2      :: (a genuinely free name attaches fine)
```

**Evidence — through the CLI**, with one match named `temp`:

```
›   Warning: .../good attached as 'good'
›   Error: database temp is already in use
```

A raw driver message naming neither the project nor the alias. Note `Temp` fails too: SQLite compares database names **case-insensitively** while both JavaScript guards use case-sensitive `Set` / `includes`. A directory named `main` or `Main` fails the same way. A scratch checkout named `temp` is ordinary.

**Verified fix:** seed `taken` with the reserved names SQLite always answers to — `main`, `temp` — in addition to what the pragma reports, and compare case-insensitively on both guards. **Boundary check (1):** a `main`/`Main` directory is the same defect and must be covered by the same fix. **Empirical re-test (8):** re-run the `temp` fixture and assert the alias allocated is not `temp`.

**Status: FIXED** — `packages/store/src/union.ts` (`ALWAYS_PRESENT`, `databaseNames`, `foldDatabaseName`, `attachStore`), `packages/cli/src/commands/query.ts` (`allocateAlias`, the `taken` seed), 3 tests in `packages/store/test/readonly.test.ts` and 1 in `packages/cli/test/query.test.ts`. What the eight checks changed:

- **The root cause was a false comment in the store, not the CLI's set.** `databaseNames`'s doc already said *"`main` and `temp` included"*. That was false — the pragma omits `temp` — and the CLI trusted it. So the fix is in `databaseNames`, which now returns the pragma's list **plus** the names the pragma omits, and `attachStore`'s own guard (`union.ts:324`) also folds. Both guards share one function, so they cannot disagree. Verified at the driver: a fresh connection reports `main` alone, and `ATTACH ... AS temp` is still refused `errcode=1`.
- **Check 1 (boundary).** The reserved set is exactly `{main, temp}`, measured rather than assumed: `ATTACH AS Main`, `AS MAIN`, `AS Temp`, `AS TEMP` are all refused, `AS main_2` and `AS asc_union_0` succeed. On a case-insensitive filesystem `Main` and `Temp` cannot even be created as separate directories — this machine has four dirs where six were named, which is why the CLI fix is tested with a `temp` directory and the case-folding with `attachStore` directly.
- **Check 2 (mirror path).** Two guards existed and both were wrong in the same way, which is why one fix covers both: `allocateAlias`'s `taken` set and `attachStore`'s `includes`. `foldDatabaseName` is exported and used by both, so a future third caller cannot invent a third rule.
- **Check 6 (interaction) — checked, deliberately not taken.** A directory named `main` already worked before this fix (the pragma reports `main`), so no test was added claiming otherwise: a test that passes before and after is not evidence.
- **Check 8 (re-test).** Met. Before: `db.exec` surfaced `database temp is already in use` with exit 1 and no project attached. After: `temp attached as 'temp_2'`, exit 0, the query answers, and `already in use` appears nowhere in the output.
- **One sub-claim is kept but NOT covered by a test, and that is recorded rather than smoothed over.** The CLI-side fold (so `Temp` is not handed out on a connection holding `temp`) cannot be discriminated on a case-insensitive filesystem: it needs two project directories differing only in case. Mutation **M7** — reverting the CLI's `taken` to unfolded names — **killed no test**, because `databaseNames` alone now fixes the measured case. The fold is kept because the rule it encodes was verified directly against the driver, and because its failure mode is a correct-but-confusing refusal, not a wrong answer. The code comment says exactly this.

### B12 — The `--help` example can never work, and its error blames the user for the one thing that is correct

**Lens:** 5 (error path), 7 (environment divergence) · **Confidence:** Confirmed (empirical) · **Urgency:** Medium

**The example.** `cli/src/commands/query.ts:287`:

```ts
"<%= config.bin %> query 'SELECT * FROM other.entries' --across '~/projects/*'",
```

and `query.ts:343`: `const matches = globSync(pattern, { cwd })`. Node's `fs.globSync` performs **no tilde expansion** — `~` is a literal directory name — and the example is single-quoted, so the shell does not expand it either.

**Evidence — running the help example verbatim:**

```
3a globSync("proj_*")              :: ["proj_1","proj_2"]      (globbing itself works)
3b globSync("~/projects/*", {cwd}) :: []
3d globSync($HOME + "/*")          :: 17 entries
```

```
$ asc query 'SELECT 1' --across '~/projects/*'
 ›   Error: --across matched no projects: '~/projects/*' (searched from /private/var/...)
 ›   A glob that matches nothing would query an empty corpus and report that as your data.
 ›   Check that the pattern is quoted, so your shell did not expand it first.
```

**The last line is the misdiagnosis.** Quoting is exactly what broke it. The example is not merely wrong — it teaches a rule that, if followed, keeps failing, and it is aimed at the corpus `ARCHITECTURE.md:421` names (the real `~/.claude/projects/` tree). A model copying an example from `--help` is the expected user here.

**Verified fix:** expand a leading `~` before globbing (`pattern.replace(/^~(?=\/|$)/, homedir())`), and correct the error text. **Failure mode (5):** the expansion must not fire on `~user` (which means another user's home and cannot be resolved by `homedir()`), so anchor on `~/` or a bare `~`. **Mirror path (2):** check whether any other help text or default uses `~`. **Empirical re-test (8):** run the corrected example and assert it matches.

**Status: FIXED** — `packages/cli/src/commands/query.ts` (`expandHome`, `describePattern`, the refusal text), 3 tests in `packages/cli/test/query.test.ts`. What the eight checks changed:

- **Check 2 (mirror path) — run, and it came back clean.** Grepped every `~` in `packages/cli/src`: the only one in user-facing text is this example (`output.ts:125-126`'s two `~` are "approximately" in a comment). No default, no other help text, and `--across` is the only flag that takes a glob. So this was the single site.
- **Check 5 (failure modes) — the dangerous direction was expanding too much, not too little.** `~user` means another user's home, which `homedir()` cannot resolve; expanding it would search *our* home under the other user's name — a silent wrong answer rather than a refusal. Anchored on `~/` or a bare `~`, and there is a test asserting `~root/nothing-*` is reported unexpanded and does not reach our home directory.
- **Check 4 (constraint values).** Concatenated, not `join`ed: `join` would also normalize the pattern — collapsing `..`, dropping a trailing slash — which is a second change to a string the caller is entitled to have matched as written. Only the `~` is expanded.
- **Check 8 (re-test).** Met, and the receipt is the `--help` example itself: with `HOME` pointed at a scratch tree, `asc query '...' --across '~/projects/*'` — the exact string `--help` prints — now matches both projects and exits 0.
- **The old advice is deleted, not reworded.** The last line told the caller to quote the pattern. That is what `--help`'s own example does, and quoting is not what broke it, so the message taught a rule that keeps failing. The replacement names the two things that are actually true: the glob is matched against this filesystem, and a leading `~` means the home directory.
- **One more improvement the re-test forced.** The message now shows the expansion when it differs from the pattern — `'~/nope-*' (expanded to '/tmp/…/nope-*')` — because "matched no projects: `~/nope-*`" leaves a caller unable to tell whether their `~` was understood and the directory is empty, or never expanded at all. Verified: a pattern with no `~` is still reported exactly as written.

### F8 — `--table` can emit a lone surrogate

**Lens:** 3 (boundary), 7 · **Confidence:** Confirmed (empirical) · **Urgency:** Low

`cli/src/output.ts:117` truncates with `text.length` and `text.slice` — UTF-16 **code units**, not characters:

```ts
return text.length > maxCellWidth ? `${text.slice(0, maxCellWidth - 1)}…` : text;
```

**Evidence — `MAX_CELL_WIDTH = 60`, emoji at the boundary:**

```
5 ascii        :: outLen=60 loneSurrogate=false utf8="aaaaa…"
5 emoji at 58  :: outLen=60 loneSurrogate=true  utf8="aaaa�…"
5 emoji at 59  :: outLen=60 loneSurrogate=false
```

At offset 58 the slice keeps the high surrogate and drops the low one, and the UTF-8 encoding renders it as `�` — a corrupted character in the table view. `--json` and `--csv` do not truncate, so this is a table-only divergence.

`output.ts:88-93` makes an explicit promise this breaks: *"the elision is marked with `…` rather than silently cut, so what you see is never a plausible-looking value that is actually a prefix."* A replacement character is worse than a prefix.

**Verified fix:** truncate by code point — spread the string to an array of code points, or use `Intl.Segmenter` for grapheme clusters — so the boundary can never split a pair. **Boundary check (1):** test at `maxCellWidth - 2`, `- 1`, and `+ 1`, with the pair straddling each. **Empirical re-test (8):** re-run the three cases and assert `loneSurrogate=false` for all.

### F9 — A comment asserts a cleanup guarantee the code does not provide

**Lens:** 2 (state machine), 5 (error path) · **Confidence:** Traced · **Urgency:** Low

`cli/src/commands/query.ts:403-405`:

```ts
// After the attach, because the path that matters is the one SQLite resolved: a symlink, or a
// second spelling of one directory, would otherwise read as two projects. The attachment is
// released by the caller's `finally` even on this throw.
```

`attachScope` is called at `query.ts:312`; the `try` whose `finally` detaches begins at `query.ts:318`. `attachScope` is therefore **outside** it, and `DuplicateProjectError` is thrown from inside `attachScope` (`query.ts:404-406`). On that path the `finally` never runs and any attachment already made in the call is not released.

**No user-visible effect today** — `base.ts:168` closes the store on the way out and the process exits — which is why this is FRAGILE and not BUG. It is reported because a comment asserting a cleanup property the code does not have is the exact shape that let B4 survive review in `db.ts`, and because the moment anyone catches `DuplicateProjectError` and continues, or reuses the handle, it becomes a real leak.

**Verified fix:** move `attachScope` inside the `try` (or wrap it in its own `try/finally`). **Interaction (6):** the detach list must be populated before the throw for the `finally` to release anything, so the fix is a `try` that encloses the *allocation*, not just the use.

### Corroborations to existing findings

The same pass independently traced two findings already in this report, and adds mechanism detail worth keeping:

- **B4** — it reached the identical conclusion from source alone (`record.ts:364` → deferred `BEGIN`, `recorder.ts:261` reads before the write at `:267`), and adds the reason the busy timeout cannot help: SQLite's retry is gated on the transaction being in `TRANS_NONE`, which is false during an upgrade. It also adds a consequence I had not stated: a multi-entry batch rolls back **entirely** and exits 1, which the exit-code contract defines as "the answer was no" — so a caller's script will not retry a transient lock conflict. It could not reproduce the race (it needs two live writers); **I did**, and my measurement is the one this report rests on.
- **B8** — it adds the internal inconsistency that makes the silence indefensible: the same command refuses the analogous document-plus-flags case on the grounds that *"merging them would mean choosing a winner per property -- a rule nobody could predict from the command line"* (`record.ts:237-246`), and `naFrom` refuses an empty name rather than absorbing it (`record.ts:163-175`). The duplicate-property case is the one place that rule is not applied.
- **F2** — it cites `union.ts:41-43` for the "attaching one at a time has no ceiling" argument, narrowing my citation from `:38-43`, and makes the reachability concrete: `EV-corpus.md` streams `~/.claude/projects/`, so a corpus exceeding 10 projects is the *expected* case for this feature, not an edge case.

---

## 5c. Addendum — the correction pass, and what building the fixes established

This section exists because the fix work changed the report's own contents in three ways. All three are recorded here rather than edited silently into §2–§5, so a reader can see what moved.

### The count was 17 when you approved it, and is 21

**This is the correction owed to you.** You approved a plan to *"fix all 17 bugs, phase by phase"*, from a report whose §2 then read **10 BUG + 7 FRAGILE = 17**. Four further findings — **B11, B12, F8, F9** — were verified *after* that answer and added in §5b, which brought the totals to **12 BUG + 9 FRAGILE = 21**. §2, §3, §4 and §5b have said 21 since §5b was written; this note is so the number you were shown and the number the report states are reconcilable rather than contradictory. The four are not a scope change you did not agree to: they came from the same supplementary pass the report already describes, and they are all in `--across`, which §4 already treats as one unit of work.

### Corrections to the report's own findings, made while building the fixes

| Finding | What changed | Why |
|---|---|---|
| **F1** | Evidence-table row 6 is wrong (block comment is CAUGHT, not evaded); a seventh spelling (`INSERT INTO "entries"`) evades and was omitted | Both measured; the headline count survives, the membership did not |
| **{B1, F5}** | **Withdrawn as a ships-with set** — the two are standalone | B1's mechanism is the prototype chain, not a missing reserved name; `constructor` is legitimate and now works. F5's `a.b` is a JSON-path bug needing `assertProjectable` |
| **B1** | The "extend the reserved-name vocabulary once" remedy is wrong for B1 | Adding `constructor` to `reservedPropertyName` would refuse a name the store can store |
| **B4** | The Fix Plan's claim that *"the transaction mode is the fix"* for `registerType`'s check-then-act version selection is **refuted** — by reading (`registry.ts:354` precedes `:439`) and by measurement (10 collisions in 10 trials) | The instruction to confirm rather than assume was followed, and it overturned the premise. B4 is a genuine fix for the snapshot failure it was written for; it never covered this race, and `asc-odh` now tracks that separately |
| **F4** | Its suggested fix was already delivered by `asc-4if` — recorded as a side effect rather than as F4 work | Both findings are one defect reached from two lenses, and counting one change twice would overstate what was fixed |
| **`asc-51t`** | The bead's inferred cause — pragma **ordering** — is **refuted**; the failing step is the **constructor** itself, one step earlier. Its recommendation 1 (reorder the pragmas) would not have fixed it | A step-labelled probe replaced the inference with the failing step's name, exactly as the bead's own "suggestive at n=3, not proof" asked to be tested. The recommendation's *goal* was right and its *mechanism* was not — the same shape as R6 |

### `asc-51t` — the OPEN-path sibling of B4, and its recorded cause was wrong

Not one of this report's findings: it came from the adversarial review of E4 and was already filed before the hunt started. It is recorded here because fixing it overturned its own inference, and because B4 and it are the same failure seen at two layers — B4 is the **transaction** losing a lock in 1 ms, this is the **open** losing one.

The bead's inference, explicitly labelled *"suggestive at n=3, not proof"*, was that the pragma **ordering** caused it — `PRAGMA journal_mode = WAL` running before `PRAGMA busy_timeout`. A step-labelled probe refuted that. The failure is one step **earlier**:

```
/tmp/probe-51t-where.mjs, 20 concurrent x 12 rounds, real store
  current  240 concurrent opens, 10 failed -- EVERY ONE at step 1 [construct()]
  proposed 240 concurrent opens,  0 failed
```

The constructor's own WAL open reads, and may recover, the `-shm` index — before the next line of the module runs, so before any pragma can widen a timeout that is still **zero** at that moment. Reordering pragmas would not have fixed it. The fix is the `timeout` **constructor option**, which also removed the need for the pragma entirely.

Measured against the code that ships (`/tmp/probe-51t-real.mjs`, the real `openStore` from `packages/store/dist`, 20 concurrent x 25 rounds, three arms — the third is the mutation):

| arm | 500 concurrent opens | |
|---|---|---|
| pre-fix sequence, transcribed | **11–13 failed** | errcode **5** and **261** |
| `openStore`, as shipped | **0 failed** | |
| `openStore` with `busyTimeoutMs: 0` | **15–19 failed** | the mechanism, switched off and back on |

**Two things the fix found that the bead did not anticipate, both by measurement:**

1. **`SQLITE_BUSY` is not the only code.** 1–3 of every 11–13 real failures carried errcode **261** — `SQLITE_BUSY_RECOVERY`, i.e. `SQLITE_BUSY` with the recovery extension in the high bits. A guard written as `errcode === 5` (which the first version of this fix was) misses those, so a real fraction would have kept the bare string. The guard now masks to the primary code. This is the same shape as R8/R9/R10 — a claim about a mechanism that a measurement corrected — and it is the reason the mutation arm exists at all.
2. **Wrapping only the constructor is not enough.** The failures land on **both** sides of `new DatabaseSync`. The first version wrapped the constructor alone and left the second group exiting 1 with `database is locked`; the probe shows the change directly (`raw driver errcode 5` before, `StoreBusyError` after).

**One more defect, found and fixed in passing:** `PRAGMA busy_timeout` names its result column **`timeout`**, not `busy_timeout` — the only pragma here that does not follow the pattern. The new read-back therefore returned `(no result)`, which failed the comparison and **sounded the alarm for the wrong reason**. Worth recording because the wrong fix — loosening the comparison — would have disarmed the check entirely.

**Verified:** 542 tests pass (was 527). New: `packages/store/test/busy.test.ts` (8) and `packages/cli/test/errors.test.ts` (6). Mutation harness `/tmp/mutate-51t.mjs`: **9/9 caught, 0 survived, 0 not applied**, source restored byte-identical. The real CLI under 20-way contention: 20/20 on `record`, `types list` and `query`, 0 `database is locked`.

**Limitations, stated rather than smoothed over.** The fix does not make contention free — it makes it **wait**. One open in ~3,500 under 20-way contention still gave up after the full 5,000 ms and raised `StoreBusyError`; that is the intended behaviour, not a defect. Separately, **one run of the shipped arm recorded 2 failures whose error printed as a plain `Error` with no numeric `errcode`**, before the probe was capturing messages; ~3,500 later shipped-arm opens did not reproduce it, and **its cause is unresolved rather than explained**. And one full-suite run reported `1 failed | 541 passed` without the test name being captured; 10 subsequent full-suite runs were green.

---

### New sub-findings, verified while fixing B1 and B2

- **`propertiesFrom` (`cli/src/commands/record.ts`) swallowed `--prop=__proto__=…` mutely.** The flags were collected into an object literal, so `Object.prototype`'s `__proto__` setter ignored the non-object assignment, `Object.entries` never saw the key, and the command **exited 0 having silently discarded a flag** — not "warned and stripped", not mentioned at all. This is the write-half of B1's class in a second module. **Fixed with B1** (`3252fb3`) and pinned by a CLI test that asserts the warning fires and the key is absent from the stored row. Confirmed (empirical).
- **`toStorage`'s `prose` accumulator (`store/src/registry.ts`) has the same shape** — a per-property map keyed by a user-controlled name, built on an object literal. **Not yet a defect**: the keys reaching it are canonicalized on the way in, and no `Object.prototype` name survives `canonicalName` except `constructor`, which is a legal key and behaves correctly. Given a null prototype defensively, with the reasoning recorded in the code. **This defers to F3**: F3 is about prose keys stored verbatim while the contract says canonical, and its fix owns the canonicalization that decides whether this can ever be reachable.
- **`shapeRow`'s accumulators (`store/src/union.ts`)** and **`buildSchema`'s `shape` (`core/src/schema.ts`)** are the same shape and got the same treatment. `buildSchema`'s is the load-bearing one: it is the zod shape object, keyed by every declared property name.

**The class, stated once:** *an accumulator keyed by a user-controlled name must not be an object literal.* The read half is `Object.hasOwn`; the write half is a null prototype. Five sites in three packages; four fixed or hardened, one deferred to F3 with the reason named.

---

## 6. Fragile code — index

F1 (guard evasion) · F2 (`--across` ceiling) · F3 (prose keys) · F4 (ambiguous duplicate property) · F5 (dotted property name) · F6 (index-name collision) · F7 (`unit` whitespace). Each is detailed in §5. Every one is labelled with **the foreseeable change that breaks it** in its own entry.

---

## 7. Already Guarded

Candidates that verification cleared. Each names the guard's `file:line`.

| Candidate | Guard | Verified |
|---|---|---|
| G1 `asc-0w9` — an empty canonical name bricking the store | `core/src/spec.ts` errors + `store/src/registry.ts` refusal | **Re-verified this session:** empty type name and empty property name both throw `UnusableDefinitionError`, and the store is **writable afterwards** (`I3` succeeded). The regression holds. |
| G2 A property named `source` / `id` / `x_state` | `reservedPropertyName` at define time, `assertProjectable` before DDL | Refused with a rename suggestion; refused before any index or view is created (F5's probe). |
| G3 A property named `evidence_text` | envelope vocabulary | My own probe was refused — the guard caught me, and I switched to a different name. |
| G4 A wrong-typed value reaching the store | `recorder.ts:257-259` → `validateEntry` → `EntryRejectedError` | `recordEntry({v:'hello'})` on a `number` property threw `EntryRejectedError`; nothing was written. |
| G5 Enum values added / removed / reordered | `diffTypeSpec` | Added → `minor`; removed → `major`, with the reason *"entries already hold it"*; reordered → `none` (the value set is identity, order is not). Correct on all three. |
| G6 Deleting a registered type | `entry_types_cannot_be_deleted` trigger | Intentional immutability. It is also why B6, F3, F4 and F7 cannot be repaired retroactively — recorded here so the constraint is visible in the fix plan. |
| G7 A read-only connection writing, including across `ATTACH` | `db.ts:37-48` | Documented and previously measured; I did not re-measure it this session. |
| G8 Unserializable `json` values | `canonicalJson` | Refuses NaN, Infinity, `undefined`, bigint, function and symbol, each with a message naming the kind. The `Date` case (B9) is the gap in an otherwise real guard. |

---

## 8. Refutation Log

Every BUG/FRAGILE above survived Step 5. These did not. **Five headline claims died, four to errors in my own probes** — recorded because a wrong finding costs a reviewer an hour, and because the pattern (a probe that passes the wrong argument shape and reports a false green) is itself worth naming.

| # | Claim | Killed by | Verdict |
|---|---|---|---|
| R1 | "A `number` property accepts an arbitrary string — `{v:'hello'}` validates ok" | **My probe bug.** I called `validateEntry(spec, {v:'hello'})`, but the input shape is `{properties:{v:'hello'}}`, so the value was never seen. With the correct shape: `ok=false, "Expected number, received string"`. | **Refuted.** The write path type-checks correctly (see G4). |
| R2 | "`validateEntry` does not type-check values at all" | Same probe-shape error as R1. | **Refuted.** |
| R3 | "`typeHash` does not cover enum values — `['a','b']` and `['a','c']` hash equal" | **My probe bug.** I used the key `values`; the spec key is `enum_values`, so both specs had *no* values and were identical. `canonicalizeTypeSpec` warned me — *"property 'k' is an enum with no enum_values; it can never validate"* — and I read past it. With the right key: different hashes, and a correct `minor`/`major` diff. | **Refuted** (see G5). |
| R4 | "A duplicate enum value makes the shape hash differ while `diffTypeSpec` says `none`, arming `registerType`'s 'bug in @ascend/core's diff' throw" | Same `values`/`enum_values` key error. Re-run: `sameHash=true`, `diff={"bump":"none","changes":[]}`. A duplicate value is a **warning** and a genuine no-op. | **Refuted.** Folded into §10 at `Suspected`/none — there is no defect here today. |
| R5 | "`registerType` discards a description change when the shape is unchanged" | **Innocent explanation survived.** `registry.ts:661` `updateTypeProse` is a separate exported operation, and `cli/src/commands/types/import.ts:31-32` documents it: *"a document whose prose changed updates the prose without minting a version."* `registerType` keeping the old prose is by design; I probed the wrong entry point. | **Refuted.** The *real* prose defect is F3, which is about key canonicalization, not about the update path. |
| R6 | "The FTS index does not hold non-ASCII terms" (a subagent's framing) | Measured: raw `MATCH` finds `ошибка`, `日本語`, `таймаута`. | **Refuted as stated.** The conclusion was right and the mechanism was wrong — the index holds them; the *query builder* cannot ask. B3 is rewritten around the measured mechanism. |
| R7 | "`canonicalName('constructor')` is itself a bug" | `canonicalName` leaving an already-canonical identifier unchanged is correct; there is no `Object.prototype` concern in a pure string transform. | **Refuted as stated.** The one-line mechanism is `state.ts:149`'s `in`, which is where B1 is now anchored. |
| R8 | "`dist/` is stale — the `asc-0w9` fix is not in the build" | My grep looked in `dist/index.js`; `tsc` compiles per file, so the fix is in `dist/spec.js` and `dist/registry.js`. Proved fresh: all 43 built `.js` files byte-identical across `npx tsc -b --force`. | **Refuted.** A false alarm of mine, recorded so it is not re-raised. |
| R9 | "`refreshTypeViews` binds `undefined` and throws" | **My probe bug.** The signature is `refreshTypeViews(db, typeName)`; I called it with one argument. Its only production caller (`registry.ts:450`) passes a name. | **Refuted.** |
| R10 | "The `na` array is stored in caller order" (previous session) | My probe passed names that were **not properties of the type**, so all three were dropped as warnings and `na_json` was `[]`. Re-run with real property names: `recordEntry(...).na === ["gamma","alpha"]` vs stored `["alpha","gamma"]`. | **Refuted as run** — but the re-run found a *different* real defect: the write call's return value disagrees with the stored value. That one is §9 NR2.2, at `Suspected` for impact because I could not show any caller consuming it. |
| R11 | "The FTS index demonstrably holds the ASCII term, so `searchEntries` is fine" | My probe indexed a *property*; FTS indexes `evidence_text`. The `[]` I measured was an artifact. | **Refuted**, then re-established correctly in B3 with `evidenceText` set. |

### R-F4 — ANSWERED 2026-09-12: the collision is REACHABLE, and B4 does **not** close it

The report left this open with a stated instruction: *"fixing B4 may make it unreachable, and that should be confirmed by re-running the two-connection probe, not assumed."* It was confirmed, and the assumption it was built on is wrong.

**What the report claimed.** §4's Fix Plan, ships-with note: *"`BEGIN IMMEDIATE` (B4) also removes the check-then-act window in `registerType`'s version selection. **Do not fix the version-selection race separately; the transaction mode is the fix.**"*

**Refuted by reading.** The premise fails on the source. `registerType` reads the version it will use — the `known` probe at `registry.ts:354`, the `latest` probe at `:372`, and `vocabularyNotes` at `:416` — and only *then* opens its transaction at `:439`. The read is **outside** the transaction, so no transaction mode can cover it. `BEGIN IMMEDIATE` moves the lock to before the `INSERT`; it cannot move it to before a read that already happened.

**Refuted by measurement.** Two processes, each driving the **real** `registerType` from `packages/store/dist`, released from a shared wall-clock barrier, against one store per trial, both computing version 1 for the same type name:

```
10 trials: 10 UNIQUE collision(s), 0 snapshot failure(s)
  a: ERROR  role=a UNIQUE constraint failed: entry_types.name, entry_types.version
  b: RESULT role=b outcome=created version=1
  entry_types rows: 1
verdict :: the check-then-act race is STILL REACHABLE -- B4 did not close it, because the read precedes the BEGIN
```

**10 of 10**, with the production `busy_timeout` of 5 s. The `0 snapshot failure(s)` is B4 working exactly as designed; the 10 collisions are the window B4 was claimed to close. Harness: `/tmp/probe-race.mjs` + `/tmp/race-worker.mjs`.

**Severity, stated honestly:** the store stays **consistent** — one row, no corruption, and the loser can re-run and get version `N+1`. What the loser gets is a **spurious failure carrying a raw SQLite message**, which is why it is filed as **`asc-odh`** (P2) rather than folded into B4. It is also a `cli-best-practices` rule-8 violation (errors are context → problem → fix; `UNIQUE constraint failed: entry_types.name, entry_types.version` is none of those), and a *false* one — the definition was valid.

**Why it was not fixed under B4.** The Fix Plan's instruction was *"do not fix the version-selection race separately"*, and its stated reason was that no separate fix was needed. The reason is refuted; the instruction's premise no longer holds, so it was neither followed silently nor silently overridden — the refutation is recorded here and the fix is its own bead. The real fix is a restructure rather than a token: one transaction around the whole body, `BEGIN` above the version reads, the `unchanged` early return at `:358-370` turned into a `COMMIT`, and a rollback on the `diff.bump === 'none'` throw at `:393`. It also carries a cost worth measuring before it ships — the `unchanged` path is the **idempotent re-registration** fast path, and wrapping it would make it take an exclusive write lock where it currently takes none, so a retry-on-UNIQUE design may be the better answer. That is a design decision, not a one-liner.

**One more correction to B4's own blast radius.** The report listed `registry.ts:199` as a *second site of the same defect*. It is the same statement, but it is **not** the same defect: there the read and the write are both inside the enclosing `registerType` call, and the only window `IMMEDIATE` closes is the one inside the `INSERT` itself — real, but not the version race the note named.

---

## 9. Needs Human Review

### NR1 — Store contamination in this repository (operational, not code)

One lens agent ran the built CLI **without an explicit `cwd`**, so it wrote into this repo's own store. `.ascend/ascend.db` gained entry types `note` v1 and `hand_empty` v1 at 22:31:44Z. Verified harmless: `.ascend/` is gitignored (`.gitignore:15`) so `git status` is clean; the store has **no `'$.'` index**; its two added types landed with ordinary indexes (`idx_entries_note_text` on `$.text`, `idx_entries_hand_empty_ok` on `$.ok`); and a canary `INSERT` with a real `type_hash` **succeeded** — the repo store is writable, not bricked. The two types are nonetheless **permanent**: `entry_types_cannot_be_deleted` refuses removal, so reverting would break the immutability invariant. The agent disclosed this itself. **Decision needed:** leave them (recommended — they are inert and the constraint is load-bearing) or delete `.ascend/` and re-init. No tracked file changed.

### NR2 — Three `Suspected` items, none in the BUG list

1. **`--prop=k=<value>` with a shell-metacharacter value.** `recordCommand` (`state.ts:69`) interpolates the value unquoted into a printed command, and for an `enum` property `exampleValue` returns a **spec-authored** value rather than a fixed placeholder. I could not construct a failing case — `exampleValue` returns the *sorted* first enum value, and `.` and `-` are safe unquoted — so this stays `Suspected`: a suggestion containing a space, `;` or `$` would be a wrong suggestion, and I did not demonstrate one. **Suspected.**
2. **`recordEntry` returns `.na` in the caller's order while `na_json` is stored sorted** (`recorder.ts` `canonicalJson([...validated.na].sort())`). Measured: `recordEntry(...).na === ["gamma","alpha"]` vs stored `["alpha","gamma"]`; `findEntry` returns the stored order. The write call's return value and the read value disagree. I did not establish that any caller consumes the return value, so I am not calling it a BUG. **Confirmed (empirical) for the disagreement; Suspected for impact.**
3. **Windows path handling (lens 7, in scope per the runtime answer).** I read path handling in `cli/src/project.ts` and `input.ts` but ran **no Windows probe** — this machine is macOS. I make **no absence claim** about Windows correctness in either direction. `--across` glob expansion (`query.ts:314`) and `expandAcross` are the places I would test first. **Unverified.**

### NR3 — `asc-4if` still needs your call

Refuse the fold collision, or keep warning and name the winner. This predates the hunt and changes a shipped write path, so it is not a hunt finding; it is listed because B8 is the same class and should probably take the same answer.

**ANSWERED 2026-09-12: refuse the collision, and B8 takes the same answer.** Both landed accordingly — `asc-4if` moved `canonicalizeTypeSpec`'s collision from `warnings` to `errors`, so `registerType` refuses and writes nothing, and B8's warning became a refusal (see its Status section). The rule they now share, stated once so the next collision of this shape does not need a third decision: **a conflict between two declarations of one name is refused, never resolved.**

Two consequences worth recording, because neither was visible when the question was asked:

- **The two claims NR3's bead called false are true now, and were left in place with their sites named.** `names.ts` and `IMPLEMENTATION_PLAN.md` both said such a collision was "already refused elsewhere" while it warn-and-registered. Removing them was the other option; keeping a claim that is now accurate, but naming the function that enforces it, is better than removing a claim that has become true. The history is in the comment, because the fact that it was *false for a while* is the reason to state where to check it.
- **The refusal direction flipped `sameValue`'s tiebreak.** An uncomparable pair (`1e999` really is `Infinity`) used to resolve as "different", which was defensible for a warning and is a false report for a refusal. See B8's Check 1.

---

## 10. Report boundaries — what this hunt did and did not do

Stated plainly, because a report with no caveats reads as one that was not looked at hard enough.

- **Not run live:** Windows. No probe was executed on a Windows host, and no Windows claim is made.
- **Not built:** the Claude Code adapter (E5). Its runtime was listed, so I reasoned about library-API reachability (B9, F9) but tested nothing in an adapter.
- **Not exercised end to end:** `unionEntries` itself. F2's evidence is `--across`, which does **not** use it — I cite `union.ts:359-367` as source, not as measurement.
- **`packages/analysis`** is nearly empty (`src/index.ts` exports only `MIN_N = 20`) and yielded no findings.
- **The real 829-transcript corpus was not read** for this hunt. Every probe used fresh temporary stores under `/tmp`; the transcripts were not opened and **nothing was written to `~/.claude/projects/`**.
- **`buildSchema` is exercised only by its own tests** (F4) — that fact bounds F4's severity and is stated there rather than buried.
- **Probe hygiene:** all probes ran against built `dist` or `bin.js`, not against source, and all probe files live in `/tmp`. Three probe bugs produced false findings that are recorded in §7 rather than deleted; the pattern is that `validateEntry` takes `{properties, na}` and I twice passed a bare properties object.

---

## 11. Suggested next commands

```bash
# Re-run the two probes that carry the headline findings
node /tmp/verify-final.mjs          # B3, B4, F1, F6 and the corrected sub-probes
bash /tmp/final2.sh                 # B6, B7, F4 through the real CLI
node /tmp/recheck7.mjs              # B1, B9, F4 with the CORRECT validateEntry shape

# The empirical re-tests named in the Fix Plan, after any fix lands
node /tmp/recheck.mjs               # B2's placeholder must stop being storable
```
