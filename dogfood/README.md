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

| [0053](0053-2026-10-02-a-contradiction-refused-with-one-coordinate.md) | a tree holding **one id with two different contents** — what two branches produce from the same derived id and `merge=union` keeps — read **successfully** through the file layer: `readRecordTree` returned both lines, ordered, as two records, and the only refusal anywhere sat one layer up at index build, naming **the id and nothing else**. It was also content-blind (`recordEntry` fired on any second row with the same id, so "written twice" and "two records claiming one identity" were one error), while the CLI already drew that distinction (`asc-90h`, comparing fingerprints) — so the store held two answers to one question and the reader reached the less useful one. Three things kept it alive: the refusal lived above the layer holding `parsed.where` and discarded it, the message carried one coordinate, and the ORDER rule **documented the shape as legitimate** — *"an entry's id is derived and content-addressed … ONE id legitimately carries TWO contents"*, a third sort key existing to order them. Both halves of that sentence were **false**: derived ids are `derived:claude-code:<type>:<session>:<key>`, addressed by session and key | `asc-2ezs` (P1, fixed in the working tree) | building the bead: running the spike's S3 fixture through `readRecordTree` and following the error to whatever refused it. The bead asks for a read-time refusal naming both coordinates; **nobody was looking for the half that was already refused** at a different layer with an unusable message — and a test (*"orders two records that share an id by their text"*) asserted the defect as intended, as did the doc |
| [0054](0054-2026-10-02-a-file-with-a-cap-and-a-record-with-none.md) | the store bounded a **file** and never bounded a **record**. `MAX_BYTES_PER_FILE = 20 MiB` reads as a guarantee about the largest thing on disk and is not one: the roll condition is `head.records > 0 && head.bytes + bytes > maxBytes`, so a file already holding one record rolls *before* the oversized record rather than refusing it — the property enforced was **"a file is at most 20 MiB, unless a record is larger than that"**, and the fields that could be larger are the unbounded free-text ones (`evidence_text`, a `measurement`, a `note`). So a single line could be any size. Measured on this repo's tree 2026-10-02 over `.ascend/entries/*/*.jsonl` + `.ascend/annotations/*/*.jsonl`: **10,732 record lines, max 9,047 B, p99 2,421 B, 0 over 10,000 B, 0 over 1 MiB** — the largest is 1/116th of the 1 MiB cap the owner set that day. **The suite asserted the gap as intended**: *"writes a record larger than the cap instead of rolling forever"*, commented *"the cap bounds how many records share a file, it never refuses a record"* — correct about rollover, and a green test standing over the absence in a file where every other threshold has a matching test | `asc-8uzh` (P2, fixed in the working tree) | reading the append path against the bead's own note, which records that the byte-bounded rollover half had already shipped under `asc-i5tj.1` — so the remaining work looked like *"add the missing half"*. Somebody **was** looking for a per-record limit (the owner chose 1 MiB and *refuse* the same day); nobody was looking at what the shipped half's doc claimed, and it generalised a conditional bound into an unconditional one |

| [0055](0055-2026-10-02-an-epic-closed-with-no-reason-and-three-requirements-that-never-existed.md) | an epic was closed with the **default close reason `Closed`**, which carries no information, and its own stage criteria plus one child's close reason name **three requirements that exist in no form**: the tautology check and the temporal-block control EV-patterns requires of E7, and the effective-sample-size / pseudoreplication check `asc-xgo.1` asserts as a "NEW REQUIREMENT FOR E7". `grep -rniE "tautolog\|temporal.block\|pseudoreplic\|effective.sample\|within.day" packages/*/src` → **0 matches**, and `bd search` finds no issue tracking any of them, so they were not merely unimplemented but untracked. All nine children were accurate about themselves and the progress bar read `9/9 complete` — because it counts *children closed*, never *criteria met*, and an epic inherits requirements from three places (its plan stage, its children's close reasons, the evidence documents it cites) that a close checks none of. One criterion was satisfied in the library and unmet on the surface it is stated about: the shuffled-label control is test-pinned, but `grep -rn permutations packages/cli/src/commands/stats.ts` → exit 1 and `rankAssociations` is called with one argument (`stats.ts:387`), so `--permutations` does not exist. This is the **fourth** epic audited this way and the **third** whose criteria its code did not back | `asc-fwpe`, `asc-0hys`, `asc-jpka` filed from it; epic `asc-xgo` re-closed (P0 epic, closed unfounded) | adversarial verification of the epic's criteria against the current tree, on being asked to close it — **somebody was looking**, deliberately, and this is the discipline paying for itself. What the tool handed over **unasked** was the second finding: a line I had committed to `IMPLEMENTATION_PLAN.md` *earlier the same day* reading "E7 is 9/9 complete … left open", against `bd show asc-xgo` → `status: closed`, `closed_at: 2026-09-18T10:00:52Z` — a status four days stale, in the sentence that declared the epic sound |
| [0056](0056-2026-10-02-a-guards-clean-path-printed-a-fatal.md) | a guard's **clean** run printed `fatal: Needed a single revision` before an exit-0 note: `asc store verify --staged` asks git for `MERGE_HEAD` and treats its absence as the ordinary case, but `execFileSync` **writes the child's stderr to the parent's stderr by default**, so every non-merge run leaked git's `fatal:` for a failure the code had already decided was normal — a false alarm in any CI log that greps for one, from a guard whose whole job is to be trusted. The defect is an **absence-shaped** one: the code was correct and the output was wrong, so a test written against the code could not see it — the suite was green before and stayed green after. It is the first finding in this series from ascend code that runs a *subprocess*: until `asc-98e1` nothing in `packages/*/src` invoked `git` or any other external binary (no `child_process` import outside test helpers), so this whole class — an inherited side channel reporting an expected outcome the caller already elected — had no way to reach the product before | `asc-9flv` (P3, the gate-wiring follow-up); the leaking call fixed in the `asc-98e1` commit (P3) | **nobody was looking for it**: I ran the finished command against the real store — the `empirical-planning` "drive the real thing" step — and read the bytes on stderr. A test of a *guard* naturally asserts on exit status and on whether a refusal was named, not on stderr content; only reading a real run surfaced it |
| [0060](0060-2026-10-04-an-analysis-question-with-no-data-path.md) | `evidence_record` declares the question it exists to answer — `analysis_questions[0]`: *"How often did a result contradict its pre-registered prediction?"* — and **no property carries a prediction or its outcome**: the eight are `arms`, `bead`, `confidence`, `decision`, `measured_on`, `measurement`, `method`, `question`. `verdict` exists as a field but is a **review's** verdict (`review_completed`: `approved`/`changes_requested`/`rejected`), and `analysis_questions` is guidance only — rendered by `asc types show`, validated as text at `guidance.ts:55-64`, with no analytic consumer anywhere in `packages/*/src`. So the question the type exists to answer cannot be asked of the store, and the only probe is prose: over `docs/evidence/EV-*.md` (43 records), `grep -ci '\bREFUTED\b'` returns **17 REFUTED / 84 HOLDS / 2 NOT REACHED** — a count of the *word*, which cannot separate a prediction's verdict from a sentence mentioning one. What it already cost: the claim *"documented behaviour keeps betraying us"* could be checked against nothing else, came back 84-to-17 the other way, and was withdrawn | `asc-xqf1` (P3, open) | **nobody was looking for it** — writing `EV-43`, wanting a number for a claim just put to the user, and finding the store's own declared question has no field behind it. The class is one this codebase already knows: the `arms` property exists so a losing arm is *"a queryable field rather than a sentence buried in `measurement`'s prose"* — the same reasoning, not applied to predictions |
| [0059](0059-2026-10-03-a-scratch-fixture-wrote-to-the-real-store.md) | a **"scratch project" fixture wrote into this repo's real store** — 8 entries and a type registration — and every command exited 0 naming no store. `HOME` and `XDG_CACHE_HOME` were set to a throwaway directory, which is what this repo's own `explore-budget.test.ts` does; the store resolves from the **cwd**, which was not. `asc record`'s JSON confirms the write with `id`, `type` and `recorded_at` and names **no path**. Caught only because an unrelated survey was **re-run** and disagreed with itself: **0 non-Latin script → 8 values, field `note`, 320 U+6F22 code points** | `asc-squ` (P2, reverted before commit) | **nobody was looking for it** — the fixture was built to produce a number for `dogfood/0058` and succeeded at everything it asserted. `git status` had shown both the untracked `note_cjk` entry directory and the modified types file, and they were read past for a different question. A gate cannot see it: nothing in `pnpm test` or `align` reads `.ascend/`. The generalizable part is that **a measurement is a tripwire only if it is re-run** — the survey's number had been taken once and quoted, which is `dogfood/0057` one layer out |
| [0058](0058-2026-10-03-a-fit-that-is-2-53x-over.md) | `--max-tokens` **reports a fit it does not have** for content its ratio was never measured on. At the shipped ratio of 2, the flag answered `estimated_tokens: 786` against `max_tokens: 1000` with **`dropped: 0`** — *everything you asked for fits* — about bytes that measure **1990** at the ratio the same corpus was measured at: **1.99× its budget, 2.53× its own reported size**. The report does carry `chars_per_token: 2`, so the assumption was disclosed; nothing let the caller change it, which made the disclosure a footnote rather than a remedy. The fixture was built as the **control arm** for `--chars-per-token` and the control was the finding | `asc-squ` (P2, fixed in this work — the ratio is caller-settable) | **someone was looking, for something else** — the CJK fixture existed to test the new flag, and the shipped path it was meant to be a control against turned out to be the defect. The suite could not have caught it: its oracle measures with `Array.from(text).length / 2`, the same constant the estimator used, so every honesty assertion agreed with the bug to the token. The store cannot produce the fixture either — 6,885 records and 110,050 string values contain **0 of every non-Latin script** — so a test insisting on real records is structurally blind to it |
| [0057](0057-2026-10-03-a-cost-figure-with-no-source.md) | a P1's **entire cost argument** was a number with no source. `asc-igg8` prices a retained event log at **16,380,630 B raw / 3,937,484 gz for 16,251 tool inputs in "this project's ~35 days"**, calling it *"a measurement rather than an estimate"* and *"the whole argument for the cost"*. It appears only in the `asc-6ola` note citing it and in a model-written compaction summary — not in `spike/replay/FINDINGS.md`, not a field `replay.mjs` emits, not in git history, not in any `.ascend` entry. Re-measured over a frozen scope (132 files / 105,216 lines / 459,944,234 B, `timestamp <= 2026-10-03T09:08:02Z`): the closest shape, the slim log `asc-bolz` actually built, is **22,043,834 raw over 27,462 inputs** — **1.35× the carried bytes over 1.69× the carried inputs**. The span is wrong too: this project's transcript directory is **2026-09-12 .. 2026-10-03, 21 days**, not ~35. The tell of the class: **right order of magnitude, wrong number, no scope** — a carried figure is real but was measured on a corpus nobody recorded. `asc-6ola`'s close note already warns *"A carried figure is not a measured one"* — in the same description that carries one | `asc-igg8` (P1, premise unproven; description amended) | **somebody was looking, deliberately** — the premise chain of a P1 was audited before designing against it, so this is *not* the "nobody was looking" case and should not be cited as one. What it evidences is narrower: **a figure survived a bead, a plan, a spike and a close reason without anyone re-deriving it**, and the only thing that caught it was a reader choosing to check. The audit itself was cheap — one `bd show` and three `rg` calls — because the artifact that would have held the number is in the repo and searchable; the expensive part was the decision to look. The rule that would have prevented it is the repo's own: *paste exact tool output rather than paraphrasing a number* |

| [0067](0067-2026-10-06-a-p-that-travelled-without-its-row-order.md) | **the shuffled control's p is a function of the caller's row order, and every surface said it was a function of its parameters alone.** `permutationNull`'s doc comment read *"The RNG is seeded from `random.ts`, so a control is reproducible from its parameters"* — true of the seed and the iteration count, and silent about the input, because Fisher-Yates walks the array it is **given**. Same columns, same seed, same 400 iterations, two row orders, and the observed χ² identical in both (which is what rules out a differing row set): `project × tool_name` **0.184539** read through the command's own path and **0.209476** read from the entry files in append order; `denial_kind × tool_name` **0.017456** against **0.029925**. The order is not derivable from the corpus: `packages/store/src/pages.ts:117` is `ORDER BY recorded_at, id`, the **ingest** clock, so the tree's append order is a different order and no file records either. A second, unstated asymmetry in the same control: it permutes the **second** column of a pair, so `--correlate project --correlate tool_name` gives **0.184539** and `--correlate tool_name --correlate project` gives **0.189526** on one pair and one iteration count — different nulls, not a disagreement. Every shuffled p in `docs/evidence/EV-patterns.md` is tied to `spike/spike-patterns.mjs`'s scan order and to nothing else, which the record does not say | `asc-t0x8` (P2, fixed in the `asc-jpka` working tree) | **nobody was looking for it** — it surfaced because the approved plan happened to state one number a reader could check by hand, and the check the plan had written for itself failed. The false claim was in a **verification section**, where a claim is least likely to be tested and most likely to be believed. The existing reproducibility test could not have caught it: *"is reproducible from its seed, and varies with it"* passes because it calls the function twice with **the same array object**, the one ordering a reproducibility test naturally holds fixed — varying the order means deciding to build a second array. The first order-sensitivity test written against the existing balanced 3×3 fixture moved the p95 by one ulp (`5.55` → `5.550000000000001`), which is a good way to conclude there is no effect |
| [0066](0066-2026-10-06-a-floor-that-came-from-the-other-control.md) | **a p floor whose iteration count came from the other control**, and it was then quoted into a work item's acceptance. `docs/evidence/EV-patterns.md` states the shuffled-label control floors at **p=0.0025 = 1/5001** because it ran **5,000** iterations; the file the record names as its own method, `spike/spike-patterns.mjs:86`, runs `{ iterations: 400, seed: 12345 }` — floor **1/401 = 0.0024937655860349127**, which prints as `0.0025`, so nothing looked inconsistent. The 5,000 is real and belongs to `spike/spike-controls.mjs:27`'s **block** control, a different null over a different column, which re-uses 400 itself at `:256`. `git log -p --follow -- spike/spike-patterns.mjs \| grep -n "iterations: [0-9]*"` returns **one line, added in `2904153`, never revised** — so this is not a spike that drifted from a record that was once right. `grep -n "5,000\\\|5000\\\|1/5001\\\|1/401" docs/evidence/EV-patterns.md` returns **5 occurrences, 4 wrong**, and the sentence at 156–157 states `0.0025` **and** `1/5001` in adjacent clauses, which contradict each other. It propagated outward: `asc-jpka`'s acceptance reads *"the achievable p floor (EV-patterns measured a 5,000-iteration floor of p=0.0025)"* | `asc-h3sv` (P3, fixed in the `asc-jpka` working tree) | **nobody was looking for it** — it surfaced from work that had to *state* the floor rather than use it, deciding whether it was a constant or arithmetic and opening the script to find out. The number reached a **requirement**, not just prose, so a later reader checking the acceptance against the command would find `0.002494` and have no way to tell which side was wrong. One of the five occurrences is **correct** (the block control really does run 5,000) and a find-and-replace across `5,000` would break a true sentence to fix four false ones |
| [0065](0065-2026-10-05-a-correction-the-plan-recorded-and-the-code-did-not.md) | a correction the plan made **never reached the code that cited the number**. `IMPLEMENTATION_PLAN.md:4377` records twelve block-control values in `packages/analysis/src/association.ts`'s `blockPermutationNull` doc comment as **WRONG** and superseded — *"none of those four observed statistics could be reproduced from `spike/corpus.db` by any `weekday` derivation or column choice tried"* — and names the checked-in script and `docs/evidence/EV-patterns.md` as the anchor. The plan was corrected; the doc comment and **two comments in `packages/analysis/test/controls.test.ts`** were not, so the module went on publishing `project × weekday` at 310.58/355.55/0.8594 where `node spike/spike-controls.mjs` prints **327.60 / 398.41 / 0.9432**, `repo × weekday` at 329.28/399.01/0.9078 where it prints **348.07 / 439.89 / 0.9594**, `denial_kind × weekday` at 181.71/190.86/0.6053 where it prints **185.50 / 195.39 / 0.6225**, and `tool_name × weekday` at 85.34/75.19/0.2685 where it prints **95.88 / 85.68 / 0.2667** — **twelve of twelve disagree**, and the script's four observed χ² are character-for-character the published ones, which is what settles which side is wrong. `grep -rn` for the four stale observed values returns **3 sites, 2 of them stating them as measured fact**. A second defect no correction would have fixed: the comment also read *"collapses EVERY weekday pair, and the observed statistic sits BELOW the null median in each case"* — `tool_name × weekday` is **p 0.2667**, above any conventional level, and its observed sits **above** the null median; `EV-patterns.md`'s prose says *three of the four* while its own caption says *"**All four**"* | `asc-1sgz` (P3, fixed in the `asc-h7nq` working tree) | **nobody was looking for it** — it surfaced while opening the doc comment to *cite* it in the live re-run Amendment, and the two tables disagreed on a pair I had to quote. The plan had already found and recorded the error, so detection was never the failure: **the correction went into a document about work rather than into the artifacts, and the plan is scheduled for deletion** — finishing the plan would have erased the only record that the numbers were ever wrong, leaving corrected-by-silence code. `tsc`, `eslint`, `vitest` and `align check` are all structurally blind to a number in a comment; `controls.test.ts`'s stale citations sit beside assertions over a **hand-built synthetic fixture** whose arithmetic is pinned and correct, so the wrong corpus number was decoration on a passing test |
| [0064](0064-2026-10-05-a-control-that-cannot-be-run-on-its-own-store.md) | both controls `asc-fwpe` built, measured and shipped **cannot be run against the store**, and the re-issued `docs/evidence/EV-patterns.md` describes an analysis the store cannot reproduce. The tautology check is **unformable**: the pair it exists to suppress, `project × repo`, is produced by the SPIKE's SQL over `spike/corpus.db` (`COALESCE(git_branch, '(none)')`), and **no registered type declares a repository or branch property at all**. `asc stats tool_denial --assoc` returns **3 pairs, no suppression line, family 3** — `denial_kind/project` determinism `0.46532402994588856`, `denial_kind/tool_name` `0.25292427767320824`, `project/tool_name` `0.23561402048598268`. The temporal control is **unrunnable**: filtering every `property.<name> <type>` line from `asc types show` over all **14 registered types** for `/date\|day\|week\|month\|branch\|repo/` returns **nothing**, and the only temporal property anywhere is `occurred_at`, a `timestamp`, which `--temporal` refuses by name — *"occurred_at is not a `string` or `enum` property of tool_denial, so --temporal cannot group by it. Groupable properties: denial_kind, project, tool_name."* The two corpora **agree on every shared number and disagree on the schema**: the spike reproduces the published χ² for all four weekday pairings exactly (185.50, 327.60, 348.07, 95.88) on a frozen N=409, while the live store holds **774** `tool_denial` entries and three categorical properties. This is a **"reports success wrongly"** instance: acceptance met, record re-issued with real numbers, suite green, capability absent on the user's data. **Corrected 2026-10-05 (`asc-h7nq`)**: the diagnosis is right about the symptom and wrong about the cause. The record says *"no registered type declares a repository or branch property at all"* and concludes the fields are **absent**; measured over the live store's 774 `tool_denial` entries, `branch` is populated on **774 / 774** (12 levels) and `cwd` on **774 / 774** (45 levels) — as `RecordedEntry` envelope fields — while `repo` and `git_sha` are populated on **0 / 774**. The fields the measurements needed were never missing from the schema; they were present in the **envelope** and unnameable, because `runAssoc` built its columns from `categoricalProperties(spec)` alone. So the mechanism generalizes one level further than the record states: **a spike's projection is not the schema**, and the projection can also drop a column the schema *does* carry | `asc-h7nq` (P2, open) | **nobody was looking for it** — it surfaced while running the documented flag line to CAPTURE output for this very record. The controls had been run only through `spike/spike-controls.mjs`, whose `weekday` and `repo` are columns **the spike invented**; because the spike reproduces EV-patterns exactly, nothing in the comparison looked wrong. The CLI tests could not see it either, and the honest part is that they hid it: they use a fixture type that **declares** `day` and `weekday` (added in this bead), which proves the flags work while making the real schema invisible by construction. **The frozen snapshot made it worse rather than better** — being frozen, the two shapes could never drift into disagreement |
| [0063](0063-2026-10-05-the-deadline-came-back-and-the-instrument-worked.md) | the pre-commit gate **blocked an unrelated commit because the machine was oversubscribed**, and this is the **third** occurrence of a class this repo has already diagnosed twice — `dogfood/0007` / `asc-3x1` (fixed `c5a417f`, `maxForks 12 -> 6`) and `asc-9ac` (fixed `21f443f`), whose own close reason says its red *"could not be named: no red in the 6 full-suite runs this session"*. Two runs of the same gate on an **unchanged tree**, ~15 minutes apart: RED at `duration_ms 180086` against its own `180_000` ms bound with `loadavg: 95.34 63.96 40.16` on a 12-core machine (against the **2.8–4.0** at which `asc-9ac` measured the class at 7.9% of budget); GREEN at **29489 ms** — a **~6.1×** spread, and the margin a load spike has to eat for this test, a number no prior record carries. **Growth ruled out separately**: the test `asc-3x1` was actually decided on still carries its original `120_000` ms budget — the raise was *rejected* and did not happen (`120_000` survives in **7** places in that file, and the `180_000` bounds predate the fix at `75d482f`, 2026-09-15) — and cost **25086 ms = 20.9%**, against the **24094 ms / 20.1%** measured post-fix on 2026-09-18: **+4% in seventeen days**, so a corpus that has not measurably eroded the headroom cannot be what blew a bound six times away from it. The attribution exists **only** because `asc-9ac` built `vitest.failure-log.ts` to record `loadavg` **because it could not name its own red** — the instrument built for an unnamed failure named this one | `asc-pcaw` (P2, open) | **nobody was looking for it** — it arrived from running the gate twice, and the check under construction (`asc-049w` Stage 4) was not involved in the failure at all. The comfortable explanation was **growth past a fixed bound**, which is a real prior finding in this exact file and was **wrong** here; what killed it was reading `0007`'s *numbers* rather than its *shape* — and **this record's own first draft named that wrong cause**, which is why the file on disk is not the one first written |
| [0062](0062-2026-10-04-a-constant-outcome-reported-as-uncorrected.md) | a **constant outcome was reported as an uncorrected one, in the anticonservative direction**. `clusterDesignFromGroups` reaches a `rho` it cannot estimate by two routes — one cluster (`k < 2`), and every observation carrying the same value, where both mean squares are exactly `0` and the ratio is `0/0` — and only the first was recognised: the `denominator === 0` branch returned **`rho: 0, rhoSource: 'estimated'`**, which reads as *"the correction does not apply"* and is a false claim about where the number came from. `rho = 0` means `deff 1` and `n_eff = n`, so the interval comes out **narrower** than the bound's: on this repo's `tool_denial` the same row printed **`0.0% (95% CI 0.0-0.5%, n=764)`** where the bound gives **`0.0% (95% CI 0.0-27.1%)`**, a 54× wider interval on a count that did not change. **24 of 71 corrected rows** on that map land in the branch — a third — because a property's `not_applicable` row is zero successes by definition and every property has one | `asc-n007` (P2, fixed in the asc-0hys Stage 3 work commit) | **nobody was looking for it** — and the unit suite is structurally unable to: its 23 hand-derived anchors all use populations with variation in them, which is the one input an anchor-by-hand suite is least likely to contain. Reverting the bound fails 2 of the 11 new CLI tests and 1 of the 23 analysis tests, so a test *can* pin it — but only the one written after seeing it. A code review plausibly could have, and saying so is the honest part |
| [0061](0061-2026-10-04-a-green-gate-over-50-deleted-tests.md) | the gate **cannot see a deleted test**: it runs the whole suite and prints `Test Files 128 passed (128)` plus a pass count, and nothing compares that count against a stored baseline, so a deleted test and a passing test are the same word in its output. Measured while adding Stage 2's renderer tests: a `Write` replaced `packages/cli/test/output.test.ts` — **659 lines, 55 tests** — with 5, and the gate over that tree reported **`128 files / 2936 passed`**, *the same 128 files* as the run before it. The 50 missing tests were invisible until the pass count was compared against a number from earlier in the same session (`2981`); a fresh session would have had no baseline and no reason to look. The gate was green over the damaged tree **three times**. `typecheck`, `lint` and `align` were all green too — the file still compiled and still imported nothing new — so the test phase, whose whole job this is, was the one phase that could not see it. `ascend` baselines the two quantities next door (`align`'s `baselined debt: 21 → 21`, `asc store verify --staged`'s `1 baseline(s) … no lost record ids`) and not this one | `asc-049w` (P1, open) | **nobody was looking for it**, and only memory caught it — the pass count disagreed with a figure carried in context, which is not a mechanism anyone can rely on. The damage never reached a commit (repaired before `fd96e49`, verified by name-diffing every touched file against `HEAD`: `LOST=[]`, 3 added) |

Sixty-seven findings, each with its own mechanism. The mechanism is the part that repeats even when
the findings do not, so each record states its own explicitly.

> **Adding 0066 and 0067, the detector ran first and agreed a twenty-ninth time — twice, and the two
> were not the same case.** `grep -c '^| \[0'` returned **65** against a sentence saying Sixty-five
> before the edit. Both rows were prepended above 0065, the newest row on disk, and the count re-run
> reads **67**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` now returns **68**, which is 67 records
> plus `0000-template.md`. The reconciliation by NUMBER ran **mid-edit** and is the reason this note
> says so: with the two files written and the index untouched, `comm` of the disk numbers against the
> indexed numbers returned exactly three lines — `0000` on the disk side, and `0066` and `0067` also
> on the disk side — which is the detector naming precisely the rows that were missing and nothing
> else. That is a stronger check than the pre-edit one, which can only see agreement; a detector run
> between writing a record and indexing it states the gap in both directions.
>
> **Two records in one pass, and the pairing was not planned.** They are the same class — a
> measurement that travelled without its parameter — and they arrived in the same flag on the same
> day from two different directions. `0066`'s parameter is a **number** that was dropped
> (`iterations`, 400 → 5,000) and travelled out of the record into `asc-jpka`'s acceptance. `0067`'s
> was never a value at all: it is the **caller's array order**, an input the function does not name
> and therefore could not require, and the doc comment's own claim of reproducibility is what kept
> anyone from looking. They are kept separate because the mechanisms differ at the point that
> matters — `0066` is prevented by deriving the floor instead of restating it, `0067` by naming the
> input the signature omits — and a merged record would have buried the second behind the first.
>
> **Both were fixed in the pass that found them, and neither fix is a test alone.** `0066`'s remedy is
> that the command now prints the floor as arithmetic from `N`, so it cannot be restated wrongly by
> whoever writes it down next. `0067`'s is four surfaces, of which the cheapest is the one a user
> meets first: the `--permutations` flag description says which column moves. Rejecting the two
> available statistic-changing fixes — averaging the shuffle directions, or canonicalising the row
> order inside the function — is recorded in `0067`, because both would have changed published
> numbers to make a documentation defect go away.
>
> **This note's own subject is why the counts are worth this much care.** `0066` is about a number
> quoted from an instrument that never produced it, and the index rows above are the same kind of
> artifact: a summary of a measurement, written by someone who did read the file. The convention that
> every note reconciles by NUMBER rather than by arithmetic is what made the mid-edit `comm` output
> legible as "two missing rows" rather than as an off-by-one.
>
> **Adding 0065, the detector ran first and agreed a twenty-eighth time.** `grep -c '^| \[0'` returned
> **64** against a sentence saying Sixty-four before the edit. The row was prepended above 0064, the
> newest row on disk, and the count re-run reads **65**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l`
> returns **66**, which is 65 records plus `0000-template.md` — reconciled by NUMBER rather than by
> arithmetic, as every note above does: `diff` of the disk numbers against the indexed numbers returns
> exactly one line, `0000` on the disk side, and nothing else. This note is also the first one written
> where the **count sentence was stale by more than the arriving record**: the sentence had said
> Sixty-four since 0064, and the row count still said 64, so the two agreed and the disagreement was
> only ever visible against the *files*. `0000` is the one number that makes the two methods differ,
> which is why every note above reconciles by number instead of by subtracting one.
>
> **0064 was CORRECTED in this pass, and its index row carries the correction.** The row above now
> states what the record got wrong and why, and the record itself carries a `**Status** |
> **corrected 2026-10-05** …` cell with the measurement that supersedes it — the house precedent is
> `0013`. The finding is untouched: the controls really were unrunnable on the store, and that is what
> the record was filed for. What was wrong is the **cause** it named, which matters because the cause
> is what the mechanism generalizes from. An index row is the only place a reader who never opens the
> file can learn that a record has changed, which is why the correction is duplicated here rather than
> left to the file.
>
> **The reservation lesson 0064's note records repeated here, and was avoided.** That note says *"a
> reserved number is a good idea and a reserved TOPIC is not."* 0065's number was not reserved in
> advance — it was taken at the moment the finding was in hand, from a `grep` of the tree rather than
> from an expectation about what the work would produce. The finding is about a correction that went
> to the wrong artifact, which is not a topic `asc-h7nq`'s plan (a live re-run and an evidence
> Amendment) would have predicted.
>
> **Adding 0064, the detector ran first and agreed a twenty-seventh time.** `grep -c '^| \[0'` returned
> **63** against a sentence saying Sixty-three before the edit. The row was prepended above 0063, the newest
> row on disk, and the count re-run reads **64**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns
> **65**, which is 64 records plus `0000-template.md` — reconciled by NUMBER rather than by arithmetic,
> as every note above does: `diff` of the disk numbers against the indexed numbers returns exactly one
> line, `0000` on the disk side, and nothing else. The 0061/0060 inversion 0062 noted, and the 0063/0062
> order, were left where they were found.
>
> **The number was RESERVED before the finding existed, and it reserved the wrong finding.**
> `asc-fwpe` wrote `dogfood/0064` into `DEFINITIONAL_AT`'s doc comment while the code was still being
> written, on the expectation that the record would be about the tautology — the defect the bead was
> filed for. That expectation was **wrong**: the tautology is the bead's premise, not a finding, and
> `docs/evidence/EV-patterns.md`'s 2026-10-05 Amendment is where it belongs. What the number now holds
> is the finding that arrived **unasked**, while the documented flag line was being run to capture
> output for this record. The dangling citation in `association.ts` was repaired in the same commit
> — the doc comment now cites the Amendment, which is where the *why* actually lives. **A reserved
> number is a good idea and a reserved TOPIC is not**: the citation was written from what the work
> was expected to produce, and a record that had been forced to match it would have been a worse
> record. The detector can check that `0064` exists and appears once; nothing can check that it is
> about what its reservation said.
>
> **Adding 0063, the detector ran first and agreed a twenty-sixth time.** `grep -c '^| \[0'` returned
> **62** against a sentence saying Sixty-two before the edit. The row was prepended above 0062, the
> newest row on disk, and the count re-run reads **63**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l`
> returns **64**, which is 63 records plus `0000-template.md` — reconciled by NUMBER rather than by
> arithmetic, as every note above does: `diff` of the disk numbers against the indexed numbers returns
> exactly one line, `0000` on the disk side, and nothing else. The 0061/0060 inversion 0062's note
> flagged was left where it was found, again.
>
> **This edit REWROTE its own record, and the detector is blind to that.** The first draft was written
> as `0063-2026-10-05-a-gate-that-reddens-when-the-corpus-grows.md` and asserted the cause was the
> corpus growing past a fixed bound — the story `dogfood/0007` was written about. It was wrong. Reading
> `test-failures.log`, which `asc-9ac` built to record `loadavg` at the moment of failure, returned
> `loadavg: 95.34 63.96 40.16` for the red run against the 2.8–4.0 at which that bead measured the same
> class, and the test `asc-3x1` was decided on measured 20.9% of its budget against 20.1% seventeen
> days earlier. Both facts point away from growth. The draft was deleted and the record rewritten under
> the name above. **The count is unaffected — `0063` exists once, and the reconciliation above passes —
> so nothing the detector checks can see that the file changed name, or that a wrong diagnosis was
> written and discarded.** A reader who has the first name from a transcript will find no such file.
> Flagged because the mechanism that produced the wrong draft is the finding: a diagnosis matching a
> known past finding is not therefore correct, and the only thing that separated them was reading the
> prior record's numbers.
>
> **Adding 0062, the detector ran first and agreed a twenty-fifth time — and this time the ROWS were
> also checked, which the detector cannot do.** `grep -c '^| \[0'` returned **61** against a sentence
> saying Sixty-one before the edit. The row was prepended above 0061, the newest row on disk, and the
> count re-run reads **62**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns **63**, which is
> 62 records plus `0000-template.md` — reconciled by NUMBER rather than by arithmetic, as every note
> above does: `diff` of the disk numbers against the indexed numbers returns exactly one line, `0000`
> on the disk side, and nothing else.
>
> **0061's own note says its row was "prepended above 0060", and the file does not show that.** In
> file order the tail reads 0060, 0059, 0058, 0057, then a blank line, then 0061 — so 0061 sits in a
> trailing block rather than above 0060, and 0060 sits above 0059 rather than after it. That is a
> SECOND, independent disagreement between the notes and the rows, and `grep -c` is blind to it for
> the same reason it is blind to a missing sentence (`Adding 0061`'s own note): **a row out of order
> is still a row.** Since the convention is "prepend above the newest", 0062 went above 0061 as that
> convention reads it, leaving the 0061/0060 inversion exactly where it was found rather than
> re-ordering rows a previous edit placed. Flagged here rather than fixed silently, because the
> ordering drift is the thing a future reader will otherwise re-discover.
>
> **Adding 0061, the detector ran first and agreed a twenty-fourth time.** `grep -c '^| \[0'` returned
> **60** against a sentence saying Sixty before the edit. The row was prepended above 0060, and the
> count re-run reads **61**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns **62**, which is
> 61 records plus `0000-template.md` — reconciled by NUMBER rather than by arithmetic, as every note
> above does: `diff` of the disk numbers against the indexed numbers returns exactly one line, `0000`
> on the disk side, and nothing else.
>
> **And the same near-miss happened a third time, in this edit.** The first attempt replaced the count
> sentence's opening line with the row rather than inserting above it, orphaning *"the findings do not,
> so each record states its own explicitly."* at the head of the notes. Caught by re-reading the
> region, **not** by the counter — `grep -c '^| \[0'` read 61 either way, because a missing sentence
> is not a row. That is the third occurrence of this exact shape (0058, 0056, now 0061), and it is
> the standing argument that the detector checks the COUNT and cannot check the ROWS. The row above
> was placed with the blank line before it visible in the anchor for that reason.
>
> **Adding 0060, the detector ran first and agreed a twenty-third time.** `grep -c '^| \[0'` returned
> **59** against a sentence saying Fifty-nine before the edit. The row was prepended above 0059, and
> the count re-run reads **60**. `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns **61**, which is
> 60 records plus `0000-template.md` — reconciled by NUMBER rather than by arithmetic, as every note
> above does: `diff` of the disk numbers against the indexed numbers returns exactly one line, `0000`
> on the disk side, and nothing else.

> **Adding 0059, the detector ran first and agreed a twenty-second time.** `grep -c '^| \[0'` returned
> **58** against a sentence saying Fifty-eight before the edit, and the row was prepended above 0058 —
> with an anchor chosen so that a wrong edit fails loudly rather than clipping a neighbouring row,
> which is the near-miss the two notes below record happening twice. The count re-run reads **59**.
> `ls dogfood/ | grep -E '^[0-9]{4}-' | wc -l` returns **60**, which is 59 records plus
> `0000-template.md` — reconciled by NUMBER rather than by arithmetic: `diff` of the disk numbers
> against the indexed numbers returns exactly one line, `0000` on the disk side, and nothing else.

> **Adding 0058, the detector ran first and agreed a twenty-first time.** `grep -c '^| \[0'` returned
> **57** against a sentence saying Fifty-seven before the edit. The row was added flush after 0057 and
> the sentence moved to fifty-eight — and the first edit **clipped the 0057 row's opening**, caught by
> re-reading the table rather than by any counter: the row count had gone to 58 either way, because a
> truncated row still starts with `| [0`. The count re-run reads **58**. `ls dogfood/ | grep -E
> '^[0-9]{4}-' | wc -l` returns **59**, which is 58 records plus `0000-template.md` — reconciled by
> NUMBER rather than by arithmetic, as every note above does: `diff` of the disk numbers against the
> indexed numbers returns exactly one line, `0000` on the disk side, and nothing else. Two notes in
> this series now record the same near-miss (0056 earlier today), which is the argument that the
> detector checks the COUNT and cannot check the ROWS.

> **Adding 0057, the detector ran first and agreed a twentieth time.** `grep -c '^| \[0'` returned
> **56** against a sentence saying Fifty-six before the edit; the row was added flush after 0056, the
> sentence moved to fifty-seven, and the count re-run — **57**. `ls dogfood/ | grep -E '^[0-9]{4}-' |
> wc -l` returns **58**, which is 57 records plus `0000-template.md` — reconciled by NUMBER rather
> than by arithmetic, as every note above does: the numbers on disk are `0001`–`0057` and the numbers
> indexed are `0001`–`0057`, with no gap and no repeat on either side.

> **Adding 0055 and 0056, the detector ran first and agreed a nineteenth time.** `grep -c '^| \[0'`
> returned **54** against a sentence saying Fifty-four before the edit; the two rows were added flush
> after 0054, the sentence moved to fifty-six, and the count re-run — **56**. `ls dogfood/ | grep -E
> '^[0-9]{4}-' | wc -l` returns **57**, which is 56 records plus `0000-template.md` — reconciled by
> NUMBER rather than by arithmetic, as every note above does: `diff` of the disk numbers against the
> indexed numbers returns exactly one line, `0000` on the disk side, and nothing else. The numbers on
> disk are `0001`–`0056` and the numbers indexed are `0001`–`0056`, with no gap and no repeat on
> either side.

> **Adding 0053 and 0054, the detector ran first and agreed an eighteenth time.** `grep -c '^| \[0'`
> returned **52** against a sentence saying Fifty-two before the edit; the two rows were added flush
> after 0052, the sentence moved to fifty-four, and the count re-run — **54**. `ls dogfood/ | grep -E
> '^[0-9]{4}-' | wc -l` returns **55**, which is 54 records plus `0000-template.md` — reconciled by
> NUMBER rather than by arithmetic, as every note above does: the numbers on disk are `0001`–`0054`
> and the numbers indexed are `0001`–`0054`, with no gap and no repeat on either side.

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
