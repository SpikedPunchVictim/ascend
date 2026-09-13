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

---

## 4. Fix Plan & Interactions

Act on this section first.

**Proposed phasing** (built from the sets and constraints below, not from file proximity):

| Phase | Findings | Why together |
|---|---|---|
| 1 | **B1, B2, F1** | The two Critical false-greens and the guard that protects future store work. All S-effort, single-file, no migration. |
| 2 | **B8, B11, B12** | The CLI-silence cluster: work accepted or refused with the wrong message. B11+B12 live in the same command. |
| 3 | **B4** (+ F4-data) | One transaction-mode change that also closes `registerType`'s check-then-act. |
| 4 | **B3, B5, B6, B7, B9, B10** | Independent, each with its own empirical re-test; no shared migration, so they can be committed one at a time. |
| 5 | **F2, F3, F5, F6, F7, F8, F9** | The ones carrying a design or data decision. |

**`--across` is one unit of work, not four.** It now carries four separate defects — **F2** (the `SQLITE_MAX_ATTACHED` ceiling), **B11** (the `temp`/`main` alias collision), **B12** (a `--help` example that cannot work), and F2's sibling in `union.ts:38-43` (the "attach one at a time" workaround). It is the least-tested surface in the repository. Phase 2 takes the two that are pure defect (B11, B12); Phase 5 takes the two that need a design answer (F2 and its `union.ts` sibling).

**Ship-together sets (never split across phases):**

- **{B4, F4-data}** — `BEGIN IMMEDIATE` (B4) also removes the check-then-act window in `registerType`'s version selection. Do not fix the version-selection race separately; the transaction mode is the fix. My probe reached the snapshot guard before the UNIQUE constraint, so the UNIQUE collision remains **unverified** — fixing B4 may make it unreachable, and that should be confirmed by re-running the two-connection probe, not assumed.
- **{B1, F5}** — both are "a name the guard vocabulary does not cover reaches a layer that assumes it does." B1's repair is in state resolution; its cheap second line is extending `reservedPropertyName`. F5's is `assertProjectable`. Extend the reserved-name vocabulary **once** and have both consumers use it — otherwise the two lists drift and the class returns.
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
**Verified fix:** `BEGIN IMMEDIATE` for the store's own write transactions (`withTransaction` and `withRollback`, `db.ts:289-302`). **Caller contract (7):** this changes *when* a concurrent writer blocks — at `BEGIN` rather than at the first write — which is the point, because the busy timeout then applies. **Interaction (6):** it also closes `registerType`'s check-then-act version selection; see §9 (R-F4). **Empirical re-test (8):** re-run probes 1c/1d and assert no `errcode=517`.
**Note on the comment:** the comment must change with the code. It currently records a reason that measurement refutes, which is how the defect survived review.

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
**Verified fix:** detect the repeat while accumulating `--prop`, and emit a warning on the existing channel naming both values and which one won — consistent with `state.ts:88-96`. **Failure mode (5):** refusing outright (exit 2) is also defensible and is stricter; the project's own precedent favours warn-and-keep, so that is the recommendation. **Empirical re-test (8):** re-run the command and assert a non-empty stderr naming `a` and `b`.

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
scan block comment between :: EVADES
```

**Consequence:** the test's own comment states the threat it exists for — *"a second `INSERT INTO entries` compiles and passes every behavioural test in this file"*. A second write path written as `INSERT OR REPLACE INTO entries` — which is the natural way to write an upsert — passes every behavioural test **and** the guard. This is the false-green class: a check that reports green while not checking.

**Blast radius:** code — `packages/store/test/recorder.test.ts` (1 file); data — none; coordination — none.
**Verified fix:** match the whole comment-stripped source with whitespace normalized, not line by line, and cover the alternations:

```
/INSERT\b[^;]*?\bINTO\s+entries\b|\bREPLACE\s+INTO\s+entries\b/i
```

**Boundary check (1):** the multi-line case is exactly why per-line matching fails — the fix must operate on the whole source. **Failure mode (5):** the widened pattern must still not fire on the string `"SELECT * FROM entries"` (asserted today at `recorder.test.ts:591`) nor on prose mentioning the token. **Empirical re-test (8):** add all six forms to the test's self-check block, which already exists at `recorder.test.ts:584-591` for exactly this reason.

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

**R-F4 — a sub-claim that is Unverified, not refuted.** `registerType`'s version selection is check-then-act (`SELECT MAX(version)`, then INSERT), but my two-connection probe reached `SQLITE_BUSY_SNAPSHOT` (errcode 517) **before** the UNIQUE constraint could fire, so the collision itself is **Unverified**. It shares B4's root cause and B4's fix; it is not reported as a separate finding, and it is not claimed as reachable.

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
