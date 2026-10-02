# Dogfooding results: three defects ascend found in itself

**Date:** 2026-09-17 · **Epic:** E11 (Dogfood) · **Evidence:** [`docs/evidence/EV-19.md`](docs/evidence/EV-19.md)

On 2026-09-17 ascend's corpus went from **79 hand-recorded entries to 1,790**, and the analysis layer
was pointed at the record of ascend's own construction for the first time. Three beads came out of
that exercise — `asc-5x7`, `asc-80m`, `asc-ttg`. None of them came from planning, a code review, or a
bug hunt. Each was produced by *using the tool on the tool*, and each arrived through a different
mechanism.

This document records how, with the measurement behind each one.

> **A note on names.** Project identifiers are redacted throughout. The corpus spans twelve working
> directories; only this repository is named. Counts and paths that would identify the others are
> replaced with role descriptions.

---

## The setup: what made these findings possible

Before 2026-09-17 the store held **79 entries**, all hand-recorded: `decision` 38,
`stage_transition` 20, `note` 15, `stuck_event` 4, `evidence_record` 2. With `MIN_N = 20`
(`packages/analysis/src/proportion.ts:50`) only two types cleared the threshold for a proportion to
be reported as an estimate rather than an anecdote — and one of those cleared it by a single entry.

`asc ingest claude-code` then derived **1,702 entries from 866 transcript files** (485,235 records,
0 malformed, 0 unreadable). The dry run predicted that count exactly, which was itself the first
real-world exercise of the `asc-vaw` fix — the fix that exists so a preview cannot report a corpus as
clean that the real run would die on.

**Corpus after: 1,790 entries across 10 types. Six clear `MIN_N`, up from two.**

That volume is the precondition. At 79 entries none of the three findings below was reachable.

---

## The records

Each finding has its own record under `dogfood/`. This page is the index and the shared
context; the depth lives in the numbered files.

| # | finding | bead | surfaced by |
|---|---|---|---|
| [0001](0001-2026-09-17-explore-omits-wilson-intervals.md) | `asc explore` reports proportions as bare counts | `asc-5x7` (P1) | a pre-registered prediction, tested against real output |
| [0002](0002-2026-09-17-benchmark-temp-dirs-ingested.md) | ascend's own benchmark wrote into ascend's own corpus | `asc-80m` (P2) | the unclassified remainder — nobody was looking |
| [0003](0003-2026-09-17-recording-is-never-one-step.md) | recording an entry is never one step | `asc-ttg` (P2) | the discipline task auditing itself |
| [0004](0004-2026-09-18-the-corpus-records-identity.md) | the corpus records who and where you are | `asc-37x` (P1) | a direct question, widened into a scan of every column |
| [0005](0005-2026-09-18-evidence-text-carries-tool-boilerplate.md) | `evidence_text` is 43 words of tool boilerplate before it is the user | `asc-m4u` (P2) | hand-reading merges from a measurement about something else |
| [0006](0006-2026-09-18-recorded-at-is-the-ingest-clock.md) | `recorded_at` is the ingest clock — 94.7% of entries share one instant | `asc-bn0` (P2) | a refusal whose stated reason did not survive a check against the data |
| [0007](0007-2026-09-18-the-suite-races-itself.md) | The gate's red was the suite competing with itself, on a deadline a growing corpus sets | `asc-3x1` (P2) | a hypothesis that predicted "quieter is faster" meeting a quieter run that was slower |
| [0008](0008-2026-09-20-the-key-claimed-a-scope-its-guard-did-not-cover.md) | the derived key claimed uniqueness over a scope its guard did not cover | `asc-iq6` (P0) | a red gate read as known flakiness, until a quiet re-run named a value instead of a deadline |
| [0009](0009-2026-09-22-the-installer-cannot-install-into-us.md) | the installer we shipped cannot install into this repository | `asc-cjm` (P2) | asking whether to dogfood a just-shipped hook, then checking whether the destination file was tracked |
| [0010](0010-2026-09-23-the-segmenter-runs-program-text.md) | the command segmenter reads multi-line program text as commands | `asc-7gz2` (P2, fixed in `a755937`; live store migrated) | eyeballing a matcher's input distribution before trusting it — nobody was looking |
| [0011](0011-2026-09-23-a-session-is-not-a-randomization-unit-here.md) | a per-session holdout has about two units per arm in a long-session project | `asc-6ola.4` (P1) | a power check printing a count nobody asked for (`sessions 4`) beside an ICC that clamped to 0 — nobody was looking |
| [0012](0012-2026-09-23-a-pipe-hides-every-failing-test-run.md) | the event model's success flag reports every failing test run as a success (a pipe masks the exit status) | `asc-6ola.6` (P0) | a read-only review agent, re-verified by hand; the mechanism was already known and routed around in one metric, never filed |
| [0013](0013-2026-09-23-ingest-undoes-the-scrub.md) | ~~every ingest since the store scrub has written the real identity back~~ **corrected:** by design (asc-hqr); the real residue is the hand scrub splitting one project label into two spellings (288 / 105) | `asc-o3tn` (P2; `asc-i2kw` closed) | a dry run's collisions on types whose rule had not changed — nobody was looking; the first reading missed a closed ruling because `bd search` hides closed issues |
| [0014](0014-2026-09-23-scrub-collisions-blamed-on-transcripts.md) | a full re-ingest blames 1,135 scrub-caused collisions on reused transcript identities | `asc-o3tn` (P2; message fixed, label split open) | the same dry run: collisions where the plan predicted none — nobody was looking |
| [0015](0015-2026-09-24-prettier-write-counted-as-a-check.md) | `prettier --write` is recorded as a verification run: 44 of the 83 prettier `verification_run` rows came from a `--write` segment | `asc-6ola.15` (P1, fixed) | grouping the runners a new handler emitted (asc-6ola.7) — nobody was looking |
| [0016](0016-2026-09-24-single-form-window-kind-false-green.md) | a refactor of the window match dropped the kind check, so a `tool.use.start` satisfied a `check.run` window | none filed (fixed in-flight under `asc-6ola.8`) | the acceptance fixture replay of `edit-verified` after refactoring the window match |
| [0017](0017-2026-09-26-task-notifications-arrive-in-records-the-parser-never-reads.md) | a task notification arrives as a record shape the parser never reads, and the counter that exists measures a disjoint population, so 36 of 80 returns were dropped uncounted | `asc-ggd4` (P1, fixed) | a pre-registered count taken before it was measured, then asking the data rather than the handler why it came out short (`asc-6ola.9`) |
| [0018](0018-2026-09-26-a-report-that-cannot-show-its-own-remainder.md) | a window decided with "no match" incremented nothing, so `asc handlers check` printed `triggers 3358, rows 2815, unclosed 55` on `edit-verified` with 488 of 3,358 triggers (14.5%) accounted for nowhere | `asc-gtnu.6` (P2, fixed in `25d4504`) | writing the honest-accounting rule for a NEW count (`noMatch`, Stage 3 of `asc-gtnu`), which put a number beside the old one that did not fit — nobody was looking for it |
| [0019](0019-2026-09-27-a-reviewer-route-that-never-names-the-reporting-tool.md) | the reviewer route `CLAUDE.md` names (the bug-hunt skill) never mentions `ReportFindings` (`grep -c` 0) and mandates a Markdown report, so a review run through it is not counted; an explicit brief reached the tool in 2 of 2 headless sessions (an anecdote) | `asc-gtnu.14` (P2, fixed by `.claude/skills/lens-review/`; superseded by a `say:` handler, `asc-tuur.6`) | writing the reviewer brief for `asc-gtnu.8` word for word, which meant reading the document the instruction delegates to — nobody was looking for it |
| [0020](0020-2026-09-27-a-skill-activation-per-subagent.md) | `skill_activation` makes one activation per subagent stream that inherits `attributionSkill`: 24 bug-hunt activations over 6 sessions, 17 of them subagents; a subagent's own `Skill(bug-hunt)` without the attribution yields none | `asc-gtnu.17` (P2, fixed in `b468a92`; live store migrated) | a count of bug-hunt runs the user knew was too high, while designing workflow-free capture of review findings — nobody was looking for it |
| [0021](0021-2026-09-27-a-refusal-that-blames-the-wrong-cause.md) | a `--full` re-ingest refused 994 derived rows as "most often a transcript edited after it was ingested"; 994 of 994 are rows the store holds redacted, so the stated cause is wrong and the rows can never reconcile | `asc-j0vh` (P3, fixed: the message) | re-deriving `skill_activation` for `asc-gtnu.17`, which printed refusals for three types it did not touch — nobody was looking for it |
| [0022](0022-2026-09-27-a-drafted-handler-credited-every-skill-in-the-session.md) | the first real `asc types capture` draft credited a table to all 4 skills loaded earlier in the session (1 writes it) and printed `refused.class 34` for 17 rows | `asc-tuur.5` (P2, fixed in `9792efb`) | checking Stage 4's success criterion on this repository's own transcripts — nobody was looking for it |
| [0023](0023-2026-09-27-an-install-message-that-contradicts-itself.md) | `asc install-hook`'s consent text said it would rewrite a script that "does not exist yet", and called a hook inert in a checkout that has a store | `asc-tuur.6` (P3, fixed in flight) | the user upgrading an install and pasting the output — nobody was looking for it |
| [0024](0024-2026-09-27-a-handler-edit-counts-its-findings-twice.md) | editing a typed handler re-keys its rows and retires none: the live store's 47 `review_finding` rows under the old hash each have a twin among the 65 the edited handler writes | `asc-w8tx` (P2, fixed) | measuring a handler change in a scratch store, then asking what it does to the live one — nobody was looking for it |
| [0025](0025-2026-09-28-a-subagent-hears-its-notifications-behind-a-preamble.md) | a subagent receives task notifications only behind the harness preamble, which the parser never read: 12 of 12 there dropped, each read as a prompt nobody typed, and one async fork never returned | `asc-wkmq` (P3, fixed) | characterising the one spawn `asc-ggd4` left unclosed, after a first reading blamed cross-stream order — nobody was looking for the fake prompts |
| [0026](0026-2026-09-28-no-stored-finding-carries-its-failure-scenario.md) | no stored `review_finding` carries `failure_scenario`: 0 of 112 measured, all through the parsed route, while all 33 `ReportFindings` calls that do carry it sit in ephemeral probes ingest skips | `asc-my84` (P2, fixed: the absence is now stated on the type; the field still arrives only by the reported route) | the first run of `asc doctor`, after a first reading blamed the deriver — nobody was looking for it |
| [0027](0027-2026-09-28-a-store-with-invalidations-cannot-be-restored.md) | `asc import` refused the reserved `invalidation` scheme line from the store's own export, so no store with an invalidation could be restored from its backup | `asc-ax8c` (P1, fixed) | the first whole-store export → import, as step one of `asc-o3tn` — nobody was looking for it |
| [0028](0028-2026-09-28-the-recording-path-is-reachable-only-by-discovery.md) | a session can only record if it discovers the command, and the artifacts it reads teach one the allowlist denies: `asc record` occurs 0 times in the brief, and the shipped hook script's own invocation is `node …/bin.js` — the form one session was denied 4 times before it stopped | `asc-uftd`, `asc-l38f` (P2, committed 2026-10-01 as `275bf38`; **six** claims are corrected in its Status cell — the three about the measurement, plus the line it shipped naming a command that exits 1 (`asc-k0l9`), the cell's own false claim that the installed script carried the by-hand comment (`asc-q1mm`), and the body's 3,603-byte brief count, which measures a different registry than the cell's figures do. The stale script in this repository has since been regenerated; the general guard is `asc-mu20`; and the adversarial review of the fix corrected the advertised spelling to the operand form `asc record <type> -` (`asc-fkp1`)) | a pre-registered measurement (`asc-4so.3`) whose prediction held while the written *reason* for it turned out to be false — nobody was looking |
| [0029](0029-2026-09-28-prose-defined-onto-a-version-nobody-reads.md) | `asc types define` resolves a document's version by shape and reports `prose-updated` for a write onto a version nobody reads: a stale-shape document landed on `review_finding` version 1 (0 entries) while version 2 (112 entries) is what every reader by name shows | `asc-w0b2` (P3, open) | a probe written to check whether a prose edit had reached the live store, after misreading one `instr()` column as a flag — nobody was looking for it |
| [0030](0030-2026-09-29-a-scheme-name-is-any-string.md) | a scheme name is any string, so no layout may assume it is a path segment: `requireName` refuses only the empty string and the reserved name, and 3 of the store's 7 live scheme names are outside `[a-z0-9_]` — the refusing guard threw on the project's own corpus | `asc-i5tj.5` (P2, open; the remedy was corrected the same day — percent-encoding was not injective, bounded, or case-safe) | the first run of the new record layer against this project's own `asc export` corpus — nobody was looking for it |
| [0031](0031-2026-09-29-a-type-line-carries-no-version.md) | a `TypeLine` carries no version, so "keep FILE order" does not prevent the renumbering it exists to prevent: `merge=union` reorders before the reader sees it, and the version is read from the order | `asc-i5tj.6` (P1, open) | writing the same 10,263-line corpus forward and reversed, read back byte-for-byte, to confirm the ordering rule — nobody was looking for the type/scheme half |
| [0032](0032-2026-09-29-a-union-merge-duplicates-a-shared-record.md) | a `merge=union` merge is clean and STILL duplicates a shared derived record — positionally, once when both sides align the line and twice when they interleave it — and the reader did not dedupe: merge exit 0, 0 conflicts, 4 raw lines, 3 distinct records read | `asc-i5tj.7`, `asc-i5tj.13` (P1, fixed in the working tree) | an adversarial review of E12.1 on the same model as the authoring session, which also refuted the plan's claim that the acceptance criterion had been met "in substance" — two halves measured, the join assumed |
| [0033](0033-2026-09-29-a-tripwire-fired-because-the-work-got-done.md) | a tripwire test written to say "I have nothing to say" went red because the gap it named closed: the real corpus reached 18 `review.finding` events, and 18 = 2 calls x 9 findings — the first of those calls was REFUSED by the harness, so the deriver counts attempted findings | `asc-2uov` (P2, open) | the quality gate, run after fixing a review's findings — nobody was looking for it |
| [0034](0034-2026-09-29-an-invariant-only-one-writer-enforces.md) | `listInvalidations` casts `reason` to `string` on a comment saying only `recordInvalidation` writes the reserved scheme, but `asc import` writes it through `recordAnnotations`, which refuses only an EMPTY note: an absent note reads back as `null` and a whitespace-only one as `"   "`, both with `asc import` exit 0 | `asc-4wx6` (P2, open) | reading `listInvalidations` to write E12.4's invalidation fixture, where the comment turned out to name one writer and `grep` named two — nobody was looking for it |

| [0035](0035-2026-09-29-a-sequence-of-previews-cannot-see-itself.md) | five line producers that each ran their writer inside their own `withRollback` were correct one call at a time and could not be sequenced — 14 tests green while the module could not do the one thing it exists for: a pass could not see the scheme registered one call earlier (`SchemeError: annotation scheme 'screening' has no version 1. Its versions: (none).`), every replayed type came out version 1 (`expected [ 1, 1 ] to deeply equal [ 1, 2 ]`), and an invalidation batch emitted the reserved scheme line per claim, permanently, into a `merge=union` tree | none filed — found and fixed in-flight under `asc-i5tj.4.1` (P1, fixed in the working tree) | a throwaway probe written to ask whether b3 could call them at all — nobody was looking for it |
| [0036](0036-2026-09-29-a-closed-vocabulary-is-elided.md) | the default view of `asc types show` elides a cell mid-word, including a closed vocabulary: 7 of 18 rendered rows carry the U+2026 marker, and both `enum required` cells for `stage_transition` read `enum required [complete, in_pr…`, losing the third legal value — and the `to_status` cell drops the field's own warning, `Equal to from_status is legal and usually a mistake -- record the transition, not the state.` — while `--json` carries the full `value` and an `enum_values` array | `asc-1gnl` (P3, open) | reading `asc types show stage_transition` to fill in an `asc record` call, because a closed vocabulary has to be readable from the command whose job is to document it — nobody was looking for it |
| [0037](0037-2026-09-29-a-no-op-transition-is-a-real-entry.md) | `asc record stage_transition` accepts and stores an entry whose `to_status` equals its `from_status`, which the field's own description calls "legal and usually a mistake": the mistake lands as a durable entry that cannot be deleted and enters the count this type exists for (`How often does a stage go complete without its tests passing?`) while describing no change at all — and the safe probe for the same question exists and writes nothing, measured (`stage_transition entries: 45` before and after a `--dry-run` that printed the row and the id it would have minted) | `asc-xvz5` (P2, fixed in the working tree) | recording the value the truncated list hid, because writing an entry was the only other way to ask whether a value was legal — nobody was looking for it |

| [0038](0038-2026-09-29-a-retirement-the-rebuild-erased.md) | a deprecation that existed only in the DERIVED index: `asc types deprecate` succeeded and the index said `deprecated`, while `asc index build` — the command whose whole job is to reproduce the store from the lines — replayed the tree, found no retirement in it, gave the type back `active` and exited 0; the same migration turned out to be a **seventh** write site where the approved plan named five | `asc-i5tj.4.1` (P1, fixed in the working tree) | the flip's own verification loop run against a real project, reading a value back **after** a rebuild — nobody was looking for a deprecation defect |
| [0039](0039-2026-09-29-a-build-that-reports-success-from-half-a-store.md) | `asc index build` reads the tree and only the tree, so a half-flipped `.ascend/` builds an index of the part and reports success: with the guard removed, a 6,473-entry store with no tree built to `records 0`, exit 0 (`asc types brief` exit 0, 0 bytes — the SessionStart hook's own command), and this repo's 2,917-line tree beside that store built to `records 2917`, exit 0, listing six plausible type rows while **3,562 entries were absent** | `asc-i5tj.15` (P1, fixed in the working tree) | counting tree lines against store rows to size the cutover, then asking what a build would say about the difference — nobody was looking for a build defect |

| [0042](0042-2026-09-29-a-cache-that-cannot-survive-its-own-use.md) | `asc ingest claude-code` REPLACES `.ascend/ingest-cursor.json` with the files it read on that run, discarding every row it just used to decide what to skip, so the cursor collapses to one run's work and the next run re-reads everything: measured on the live corpus, rows **1080 → 1** across two runs, the skip run reporting *"1079 transcript file(s) unchanged since the last ingest … and were skipped without being opened"* and then writing a one-row cursor; every run alternates between a full read (**16 s**) and a skip run (**1 s**) forever. The SQL version could not lose them — `INSERT … ON CONFLICT DO UPDATE`, per file — and the whole-file write came in with `asc-i5tj.14`'s sidecar, so this is a regression the move introduced | `asc-n4eg` (P2, fixed in the working tree) | reading the sidecar while looking for something else — the vestigial `ingest_cursor` table in the derived index — nobody was looking for it |

| [0041](0041-2026-09-29-a-strike-nothing-counts.md) | an invalidation is recorded and **no read path consults it** — `listInvalidations` has exactly one caller in `packages/*/src`, `commands/invalidate.ts`, the command that writes strikes — so a struck entry keeps its place in every count and every listing: `asc types list` reported decision **92** with 1 of those 92 struck, the same 92 as before the strike, and `asc search decision "gitignored sidecar"` printed the struck duplicate and the entry that superseded it as two peer matches under *"the query terms do occur as property values"*, with nothing distinguishing them | `asc-9xi0` (P2, open) | recording two decisions from this plan's own *"Records to update"* list, the second of which the store already held — nobody was looking for the read-path defect; the duplicate was found by a count taken to verify the write path, which came back 2 where one choice existed |

| [0040](0040-2026-09-29-a-canonical-form-that-stopped-at-the-top-level.md) | `orderedLine` pins the key order of a line's own fields but passes a scheme's nested `spec` through, while `parseSchemeRule` rebuilds each rule as `{label,kind,query}` — so one scheme had two canonical spellings and `migrateStoreToTree`'s read-back check saw the tree as *"10386 line(s) written, 10386 read, 3 missing and 3 that should not be there"*, refusing the cutover on a store where exactly the 3 rule-bearing schemes of 7 disagreed and the 4 rule-less ones agreed to the byte; **both** suite fixtures had `rules: []`, so no test had ever put a rule through the format | `asc-i5tj.16` (P1, fixed in the working tree) | the first real run of `asc init` on this repo's own 23 MB store — the plan's *not measured yet* item, and its first measurement was a refusal |

| [0043](0043-2026-09-30-a-rationale-nobody-checked.md) | the doc comment that licensed keeping the dead `ingest_cursor` table was **false, and false about a module it names**: it said `migrateStoreToTree`'s report "has to name" the table so dropping it would silence the gap, but `droppedTables` (`migrate.ts:266-297`) derives the list from `sqlite_master`, not from `MIGRATIONS` — falsified on the real binary, a legacy store holding 1,070 rows run through `asc init` still reports *"the migration could not carry the ingest_cursor table: 1070 row(s)"*. The behavior was ALREADY tested and green (`migrate.test.ts` asserts that exact report line), so only the sentence about the code was wrong — an anecdote, under `MIN_N` | `asc-sh2q` (P2, fixed in the working tree) | reading `schema.ts` while scoping `asc-i5tj.4.3`, and testing the comment's own claim instead of trusting it — nobody was looking for it |
| [0044](0044-2026-09-30-a-build-that-replaces-its-file-and-not-its-wal.md) | `asc index build` reports a fingerprint the file on disk does not hold: `buildIndex` checkpoints the **staging** handle's `-wal` and renames the staging file over `index.db`, but never removes the `-wal`/`-shm` of the database it **replaces**, so a writer that committed and died before its `close()` leaves frames the next reader recovers onto the new file — the build printed `6  7f65a4b8…` exit 0 while `meta.index_fingerprint` read back `deadbeefdeadbeef`, and every read then refused with *"the tree has changed since it was built … Run `asc index build`"*, a remedy that is a **no-op: 3 further builds changed nothing**; `rm index.db-wal index.db-shm` then rebuilt and `stored == tree`. Met on this repo's own tree first (a SessionStart hook left a 675,712-byte `index.db-wal`), where **0 of 5 reads succeeded** | `asc-pwv7` (P1, fixed in the working tree) | verifying `asc-i5tj.6` on the real tree, and reading the fingerprint back **out of the database** instead of trusting the build's own report — nobody was looking for a build defect |
| [0045](0045-a-surface-that-projects-a-column-its-own-filter-cannot-name.md) | `asc explore <type> --filter` cannot name the `invalidated` column the same command prints one line earlier: the predicate is evaluated over a projection of the type's own columns (`type-filter.ts`), and `invalidated` is a value the map COMPUTES, so `--filter "invalidated is not null"` died with *"no such column: invalidated"* — while `--group-by` and `--select` both REFUSE the same name with a message listing the four declared properties, so the one door that leaks is the one whose error text ends *"If the statement was not one you wrote, this is a bug in ascend"*. **3,144 of 6,601 entries (47.6%) had stopped counting and no invocation could select one of them by that fact**; for `decision` it was 1 of 95 | `asc-bqb5` (P2, fixed in the working tree) | trying to inventory the struck entries of one type, to decide what `asc-9xi0` should move on the read path — the help is truthful, so nothing read for a contradiction turns this up |
| [0046](0046-a-preview-that-mints-an-id-it-will-not-use.md) | `asc record --dry-run` reports an entry id that **cannot** be written: `record.ts:692` mints `merged.id ?? randomUUID()` and the dry run is a separate call, so three dry runs and three real runs of byte-identical content gave six distinct ids and the store held exactly the three real ones — while `--dry-run --json` returns a row shaped like the write's (`type_hash`, `recorded_at`, `states`, `dry_run:true`) with nothing saying the `id` is a specimen, and the one obvious use of a previewed id is a command that takes ids. Scoped to a MINTED id: a document naming one round-trips exactly (`11111111-…` on both arms) | `asc-mw1u` (P3, fixed in the working tree) | dry-running three `decision` documents before writing them to an immutable store, and reading the two outputs while they were adjacent — the dry run was being read for its **warnings**; nobody was looking at the ids |

| [0047](0047-a-guard-that-stops-at-the-top-level.md) | three source-scanning guards enumerate a package's `src/` tree with a single **non-recursive** `readdirSync`, so the first subdirectory added under any of those trees is not read and the guard keeps reporting success — proven by planting a real `src/planted-probe/offender.ts` in each real tree: `INSERT INTO entries` + `Date.now()` + `node:sqlite` in the store's, `writeFileSync` in the adapter's, and the four guards still reported **`1 passed` ×3 and `11 passed`**; after `{ recursive: true }` the same plant fails 6 assertions. The bead names two guards; the sweep found **3 of 7** flat, the third (`sql-port.test.ts`) unnamed | `asc-y9ut` (P2, fixed in the working tree) | placing a module for `asc-i5tj` where `readdirSync(SRC)` sat one line from the file being moved — nobody was looking for a guard defect, and the class was only counted on the second pass, by asking what else lists a `src/` tree |

| [0048](0048-a-premise-that-expired-without-saying-so.md) | `asc-y7p`'s factual premise had **expired without saying so, and the count it was stated in still agreed**: it holds the case for field-scoped invalidation against "the 10 legacy entries" carrying the AskUserQuestion clarification preamble, and `grep -ro "The user wants to clarify these questions" .ascend/entries/ \| wc -l` now returns **0** — the deriver fix passes `evidenceText` as `undefined` for an unquotable form and re-derivation removed the contamination, with no strike written. The corpus still holds exactly **10** `user_correction` entries whose `evidence_text` is absent (all 10 `tool_name: AskUserQuestion`, tying them to the preamble entries by a field other than the one under test), so the bead's number still matches the store — only the fact behind it changed, from *contaminated* to *deliberately withheld*, and a reader checking "are there still 10?" is confirmed rather than contradicted. The bead's other premise, *"Reopen the design question when a SECOND, unrelated instance appears"*, is a condition on the store that **no query evaluates**. The trigger was measured and has **not** fired: the 3,144 strikes are only **20 distinct notes**, every one entry-level, and **497 of 498** `wrong_value` strikes on `verification_run` have no re-derived sibling — so the whole-entry strike was the correct granularity rather than a wider one | `asc-y7p` (P2, open) | going to measure the bead's own stated trigger, which first required establishing that the instance it was written about still existed — nobody was looking for an expired premise, and three detectors built for that search were themselves blind, each printing a confident number (a whole-bucket prefix scan that cannot see a 10-of-19 subset; a census keyed on `type_name` without `type_version`; a check for a `category` field the type does not declare) before being caught |
| [0049](0049-a-refused-call-that-counted-twice.md) | the deriver read a `ReportFindings` call's **input** and never its **result**, so a call the harness **REFUSED** still wrote one `review_finding` entry per finding — and because a refusal is followed by a corrected retry carrying the *same* findings, the defect **doubled** the count instead of adding a stray row. Measured in this store: `call_0o92cyc2` (refused; 6 of 9 `short_summary` over the tool's 60-character maximum, longest **79**) and `call_p374n0av` (accepted; longest **57**) differ in **0 of 9** `(file, line, summary)` triples and **0** lens values, so **18 entries stood for 9 distinct findings** and every per-lens count for that session read exactly twice what it was. Across every transcript on this machine: **35** calls, **3 refused (8.6%)**, **26** findings carried by them, of which **25 (96.2%)** are duplicated by a later accepted call — the one that is not sits in an **ephemeral** project ingest never reads, so suppressing a refusal loses **nothing** in any transcript the store actually reads. After the fix the real binary over the real 77 MB transcript wrote `review_finding 9 new`, not 18 | `asc-2uov` (P2, fixed in the working tree) | asking what a refused call's **retry** did, while working out whether the bead wanted documentation or a fix — nobody was looking for the doubling; the bead had the refusal written down and had drawn the opposite conclusion from it, and what made it findable is that the two calls are byte-identical in content, so a set comparison is decisive rather than a judgement about what "the same finding" means |

| [0050](0050-2026-10-01-the-quickstart-runs-a-command-nothing-links.md) | `README.md`'s §Quickstart runs a command nothing links onto `PATH`, and never uses the word for the thing that makes it run: measured on the committed text (`git show HEAD:README.md`, section bodies from one `## ` heading to the next), **4** command lines in §Quickstart begin with bare `asc` and **"alias" occurs 0 times** in that section, while the remedy sits 27 lines up in §Install (`alias asc='node …/packages/cli/dist/bin.js'`) — which itself measures **0** bare `asc` command lines and **2** uses of "alias". So the failure is a reader's *first* command: `command not found`, with nothing in the text they read naming the dependency. Same class as `0028`, third instance — and the sub-shape is new: the mechanism IS documented, in the wrong section | `asc-uftd`, `asc-l38f` (P3, fixed in the working tree; the sentence shipped with that pair and there is no bead of its own) | building E12.13's "which artifact names which form" table, which has one row per artifact and therefore **no column for what an earlier artifact owed a later one** — they were looking, but at artifacts, not at the seam between two of them |
| [0051](0051-2026-10-02-a-recovery-the-command-itself-refuses.md) | the fix `asc record TYPE -` prints is a command `asc record TYPE -` refuses: the document path renders every violation's remedy as `--prop=<name>=<value>` (and `--na <name>`), and a document beside either exit **2** — `a document (-) and entry flags (--prop/--na/--evidence) cannot be combined`, measured on both halves separately (`--prop=chosen=walk-up` exit 2, `--na chosen` exit 2). So the one recovery ascend names costs the caller the input they came with, and says nothing about that. `IMPLEMENTATION_PLAN.md:2478-2480` records *that recovery* as the criterion for preferring stdin over the flag form, so the rationale for the advertised form rested on a dead end. Every fix string named the right field in the right vocabulary — **reachability was never checked, only shape** — and the flags path still prints the flag spelling, so the change is a branch on `via`, not a replacement | `asc-i8cs` (P3, fixed in the working tree) | an adversarial review of the E12.14 diff asking what a caller who takes the message literally actually *runs* — nobody was looking for it, and the review had read that string as correct for three rounds; a test already covered it and covered it backwards (`record.test.ts` piped a **document** and required `--prop=missing=<value>` and `asc record pair --na missing`, green while asserting the two spellings that cannot be run) |
| [0052](0052-2026-10-02-a-report-that-arrives-after-the-wait.md) | `asc record TYPE -` read stdin **before** it resolved the type, so on a terminal the process neither printed nor exited — including for an unknown type it would have refused instantly. Measured on a real pty (`script -q /dev/null node …/bin.js record <type> -`): **both** `bogus_type` and a registered `decision` **still running after 6 s, output `''`**; on an open non-TTY pipe the same read blocked **4.1 s** until the writer closed, so the terminal only removes the thing that would end the wait. Not reachable before this week: the session path is unaffected because Claude Code's Bash tool closes stdin, and every automated check here uses `spawnSync(…, {input})` — a closed pipe — so **no portable test can reproduce it**. The rule against exactly this hang was already written at the top of `input.ts`, one step **too narrow**: it covers a *missing* input operand, not a present one whose input is a terminal | `asc-kyhh` (P3, fixed in the working tree) | reproducing a different E12.14 finding on a real pty, where the reproduction hung — nobody was looking for the ordering defect, and E12.14 had just moved this form onto the path the brief teaches every session |

Fifty-two findings, each with its own mechanism. The mechanism is the part that repeats even when
the findings do not, so each record states its own explicitly.

> **Adding 0052, the detector ran first and agreed a seventeenth time.** `grep -c '^| \[0'` returned
> 50 against a sentence saying Fifty before the edit; 0051 and 0052 were added flush after 0050, the
> sentence moved to fifty-two, and the count re-run — **52**. `ls dogfood/ | grep -E '^[0-9]{4}-' |
> wc -l` returns **53**, which is 52 records plus `0000-template.md` — reconciled by NUMBER rather
> than by arithmetic, as every note above does: the numbers on disk are `0001`–`0052` and the numbers
> indexed are `0001`–`0052`, with no gap and no repeat on either side.

> **Adding 0050, the detector ran first and agreed a fifteenth time.** `grep -c '^| \[0'` returned 49
> against a sentence saying Forty-nine before the edit; the row was added flush after 0049, the sentence
> moved to fifty, and the count re-run. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns 51, which is
> 50 records plus `0000-template.md` — reconciled by NUMBER rather than by arithmetic, as every note above
> does: the numbers on disk are `0001`–`0050` and the numbers indexed are `0001`–`0050`, with no gap and no
> repeat on either side.

> **Adding 0049, the detector ran first and agreed a fourteenth time.** `grep -c '^| \[0'` returned 48
> against a sentence saying Forty-eight before the edit; the row was added flush after 0048, the sentence
> moved to forty-nine, and the count re-run — **49**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l`
> returns **50**, which is 49 records plus `0000-template.md` — the same trap 0047's, 0046's and 0048's
> notes record, and again the two are reconciled by NUMBER rather than by arithmetic: the numbers on disk
> are `0001`–`0049` and the numbers indexed are `0001`–`0049`, with no gap on either side and neither set
> repeating another.

> **Adding 0048, the detector ran first and agreed a thirteenth time.** `grep -c '^| \[0'` returned 47
> against a sentence saying Forty-seven before the edit; the row was added flush after 0047, the sentence
> moved to forty-eight, and the count re-run — **48**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l`
> returns **49**, which is 48 records plus `0000-template.md` — the same trap 0047's and 0046's notes
> record, and again the two are reconciled by NUMBER rather than by arithmetic: the numbers on disk are
> `0001`–`0048` and the numbers indexed are `0001`–`0048`, with no gap on either side and neither set
> repeating another. 0048 is about precisely the failure that reconciliation guards against — a count
> that still agrees while the fact behind it has moved — which is why the two are compared by number and
> never subtracted.

> **Adding 0047, the detector ran first and agreed a twelfth time.** `grep -c '^| \[0'` returned 46
> against a sentence saying Forty-six before the edit; the row was added flush, the sentence moved to
> forty-seven, and the count re-run — **47**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns
> **48**, which is 47 records plus `0000-template.md` — the same trap 0046's and 0045's notes record,
> and again the two are reconciled by NUMBER rather than by arithmetic: the numbers on disk are
> `0001`–`0047` and the numbers indexed are `0001`–`0047`, with no gap on either side and neither set
> repeating another. 0047 is also the third record in a row to be filed for a bead that had been
> sitting unrecorded — filing the bead is not enough, and the lag is where a mechanism stops being
> taught.

> **Adding 0046 and 0045, the detector ran first and agreed an eleventh time.** `grep -c '^| \[0'`
> returned 44 against a sentence saying Forty-four before the edit; the two rows were added flush, the
> sentence moved to forty-six, and the count re-run — **46**. `ls dogfood/ | grep -E '^[0-9]{4}-' |
> wc -l` returns **47**, which is 46 records plus `0000-template.md` — the same trap 0044's and 0043's
> notes record, and again the two are reconciled by NUMBER rather than by arithmetic: the numbers on
> disk are `0001`–`0046` and the numbers indexed are `0001`–`0046`, with no gap on either side and
> neither set repeating another.

> **Adding 0044, the detector ran first and agreed a tenth time.** `grep -c '^| \[0'` returned 43
> against a sentence saying Forty-three before the edit; the row was added flush, the sentence moved to
> forty-four, and the count re-run — **44**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns
> **45**, which is 44 records plus `0000-template.md` — the same trap 0043's note records, and again
> the two are reconciled by NUMBER rather than by arithmetic: the numbers on disk are `0001`–`0044`
> and the numbers indexed are `0001`–`0044`.

> **Adding 0043, the detector ran first and agreed a ninth time.** `grep -c '^| \[0'` returned 42
> against a sentence saying Forty-two before the edit; the row was added flush, the sentence moved to
> forty-three, and the count re-run — **43**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns
> **44**, which is 43 records plus `0000-template.md` — the pattern matches the template too, which is
> the trap in that second count, and it is why the two are reconciled by NUMBER rather than by
> arithmetic: the numbers on disk are `0001`–`0043` and the numbers indexed are `0001`–`0043`, with no
> gap on either side and neither set repeating another.

> **Adding 0042, the detector ran first and agreed an eighth time.** `grep -c '^| \[0'` returned 41
> against a sentence saying Forty-one before the edit; the row was added flush, the sentence moved to
> forty-two, and the count re-run.
>
> **Adding 0041, the detector ran first and agreed a seventh time.** `grep -c '^| \[0'` returned 40
> against a sentence saying Forty before the edit; the row was added flush, the sentence moved to
> forty-one, and the count re-run. `ls dogfood/*.md | grep -c '/00'` returned 42 for the same 40
> records plus `README.md` and `0000-template.md` — the two ways of counting agree, which is the
> check that would have caught 0016 and 0038 when they were written and not indexed.
>
> **Adding 0040, the detector ran first and agreed a sixth time.** `grep -c '^| \[0'` returned 39
> against a sentence saying thirty-nine before the edit; the row was added flush, the sentence moved
> to forty, and the count re-run.
>
> **Adding 0038 and 0039, the detector ran first and agreed a fifth time.** `grep -c '^| \[0'`
> returned 37 against a sentence saying thirty-seven before the edit; both rows were added flush, the
> sentence moved to thirty-nine, and the count re-run. 0038 is also the second time a record was
> written without being indexed — the class 0038 itself is about, and it caught the README rather than
> the tool this time: a row that is not in the index is a row nothing will find.
>
> Rows 0016 and 0017 were added 2026-09-26; 0016 had been written but never indexed, and the
> count here said "Ten" while the table listed fifteen.
>
> **The same thing happened again, which is what makes it a class rather than a slip.** On
> 2026-09-28 the count said "Twenty-five" while the table listed twenty-seven rows — 0026 and 0027
> were added without touching it. The detector is the one `0018` states: check the headline count
> against the sum of what decomposes it. Here that is `grep -c '^| \[0'` against the sentence.
>
> Row 0018 is the second instance of `dogfood/0016`'s class — a construct that terminates without
> producing output, and a report that therefore reads the same whether it worked or not. Two
> instances in two days is what turns a class from a note into something to look for, which is why
> the record states the cheap detector: for every report, check that the headline count equals the
> sum of the counts that decompose it.
>
> **Adding 0036 and 0037, the detector ran first and agreed a fourth time.** `grep -c '^| \[0'`
> returned 35 against a sentence saying thirty-five before the edit; both rows were added flush, the
> sentence moved to thirty-seven, and the count re-run. 0036 and 0037 are also the first pair in the
> series where one finding is the *cause* of the next rather than a sibling of it: a truncated
> vocabulary is what sent a hand to `asc record` to ask whether a value was legal, and that write is
> what became the false entry.
>
> **Adding 0035, the detector ran first and agreed a third time.** `grep -c '^| \[0'` returned 34
> against a sentence saying thirty-four before the edit; the row was added flush, the sentence moved
> to thirty-five, and the count re-run. Twice in a row now the number held before an edit rather than
> being discovered wrong after one — which is what this procedure is for, and it is the first time
> the series can say that about consecutive additions rather than about a single one.
>
> **Adding 0034, the detector ran first and agreed again.** `grep -c '^| \[0'` returned 33 against a
> sentence saying thirty-three before the edit; the row was added with no blank line above it, and the
> sentence was moved to thirty-four and the count re-run. The blank-line trap `0029` records is the
> reason the row is added flush rather than after a spacer, and the count is re-run rather than
> assumed — a count that is only ever recomputed when someone suspects it is not a check.
>
> **Adding 0030-0033, the detector was run first.** `grep -c '^| \[0'` returned 29 against a
> sentence saying twenty-nine, so the two agreed before the edit; four rows were added with no blank
> line among them, and the sentence and the count were both moved to thirty-three and re-checked.
> Recording the procedure because the three previous instances were all found *after* the fact, and a
> detector that is only ever run afterwards has not been shown to work.
>
> **Adding 0029, the count held and the table was still wrong.** The sentence said twenty-eight and
> `grep -c '^| \[0'` returned 28 — correct on the number, while the row added for 0028 carried a
> blank line above it, which ends a markdown table and starts a second one. So the detector above
> counted the rows of a table that had quietly become two, and would have answered correctly for a
> table that no longer rendered as an index. A count is a check on the rows, not on the document
> holding them.

## The convention

**One record per finding**, named `NNNN-YYYY-MM-DD-short-name.md`, copied from
[`0000-template.md`](0000-template.md). `NNNN` is the next free sequence number and gives beads
a short stable citation (`dogfood/0002`); the date is when the finding *surfaced*, not when the
bead was filed or fixed. Both sort keys are kept deliberately — the number to cite, the date to
scan — at the cost of a little redundancy.

**What belongs here, and what belongs in `docs/evidence/`.** The distinction is whether anyone
asked the question:

- **`docs/evidence/EV-N.md`** answers a question **named in advance**. EV-19 pre-registered its
  question and five numbered predictions in a separate commit *before* measuring, so each could
  be marked hit or missed rather than reinterpreted.
- **`dogfood/NNNN-*.md`** records something that **surfaced on its own**, where nobody had asked.
  `asc-80m` exists because a rule failed to classify two rows.

If you wrote the question down first, it is an EV record. If the tool handed it to you, it is a
dogfood record. A finding can cite both — 0001 does.

**The one file here that is not a record.** [`types.json`](types.json) predates this convention
and stays: it is the replayable definition of the two types this project defined for itself,
`evidence_record` and `note`, exported by name so a fresh `asc init` reproduces them at
byte-identical `type_hash` values (`f2f796ca`, `96880b60`, verified in commit `8fbabef` against a
throwaway store). Schema only — a fresh clone gets the types and none of the corpus. It belongs in
this directory for the same reason everything else here does: the types exist because dogfooding
needed them. Since `asc-sny1` it also carries this project's own guidance — `purpose`,
`analysis_questions` and `review_after` — for the hand-recorded types, the four starters included.
Those values are this repository's intentions, not defaults, so they live here rather than in
`starters.ts`; `asc types import dogfood/types.json` applies them in place, with no version bump.

**The one required section is "The metric."** A finding without a measurement is an impression,
and impressions belong in a bead comment. Every measurable claim carries the measured value and
how it was obtained; where a value does not exist it is omitted, never written as `0`. Groups
under `MIN_N` (20) are named as anecdotes rather than dressed up as estimates — including when
the anecdote is about us, which 0003 is.

## Were these the default types?

**Mostly no — and the exceptions are informative.** ascend's types come from three places:

| origin | types | how they arrive |
|---|---|---|
| **Starter** (default) | `review_completed`, `stuck_event`, `stage_transition`, `decision` | installed by `asc init` from `packages/cli/src/starters.ts` |
| **Derived** | `tool_denial`, `context_compaction`, `verification_run`, `skill_activation`, `user_correction` | `asc ingest claude-code`, never recorded by hand |
| **Project-defined** | `note`, `evidence_record` | defined for this project by `asc-5ra` |

Mapping the findings onto that:

| bead | surfacing type | origin |
|---|---|---|
| `asc-5x7` | `tool_denial` | **derived** |
| `asc-80m` | `tool_denial` | **derived** |
| `asc-ttg` | `evidence_record`, `note` / `stage_transition`, `decision` | **project-defined / starter** |

**Both findings about ascend's data and analysis came from a derived type that no human ever recorded
a single instance of.** `tool_denial` is machine-extracted from transcripts. It is also the only type
with enough volume (564) and enough structure (six properties) to support the analysis — the
hand-recorded types are all small, and the hand-recorded types that carry prose are all below
`MIN_N`. The findings came from the part of the corpus a user never types.

**The friction finding is the mirror image**: it could only come from hand-recording, and it spans
both starter types (`decision`, `stage_transition`) and project-defined ones (`evidence_record`,
`note`). The cost is in the properties that hold prose, and that is independent of which of the three
origins a type has.

### A fourth observation, unasked for

**`review_completed` — a starter type, installed by default — has zero entries.**

| type | origin | entries |
|---|---|---|
| `review_completed` | **starter (default)** | **0** |
| `stuck_event` | starter (default) | 4 |
| `stage_transition` | starter (default) | 24 |
| `decision` | starter (default) | 39 |

A month of real work, including a 22-finding bug hunt, a Sonnet-vs-Opus model comparison, and dozens
of code reviews of agent output — and the type built for recording a completed review was never once
used. No bead is filed for this yet: one unused type across one project is an observation, not a
finding, and `MIN_N` discipline applies to conclusions about ourselves too. It is recorded here so
that if a second project shows the same thing, the pattern has a place to attach.

---

## What this says about the premise

E11's bet was that using ascend on ascend would find things that planning would not. The record:

- **`asc-5x7`** came from a prediction written down before looking, then tested against real output.
- **`asc-80m`** came from the unclassified remainder — the mechanism `asc-2pg` exists to provide —
  with nobody looking for it.
- **`asc-ttg`** came from the tool's own ergonomics under sustained real use, which no amount of
  reading the code would have surfaced.

Three different mechanisms, three defects, none of which a code review would have found, because none
of them is visible in the code. `asc-5x7` is an *absence* (a function that exists and is not called).
`asc-80m` is a property of the *data*. `asc-ttg` is a property of *using it repeatedly*.

The acceptance test (`asc-c9h`) returned **GO with one qualification**, the qualification being
`asc-5x7`. Full measurement, including the shuffled control and the scored predictions — one of which
missed and is recorded as a miss — is in [`docs/evidence/EV-19.md`](docs/evidence/EV-19.md).
