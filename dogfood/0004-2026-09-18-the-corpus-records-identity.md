# 0004 — the corpus records who and where you are, and immutability makes it permanent

| | |
|---|---|
| **Bead** | `asc-37x` |
| **Surfaced** | 2026-09-18 |
| **Surfaced by** | a direct question — "do the project names exist in the ascend.db?" — answered by scanning every column of every table |
| **Entry type(s)** | `tool_denial`, `context_compaction`, `skill_activation`, `user_correction` (all derived); plus `annotation_schemes` |
| **Severity** | P1 |
| **Status** | open — store scrubbed 2026-09-18, cause not fixed |

## What was found

Every entry ascend records carries the operator's absolute home path and the identity of the
project it was recorded in. Not as one field that could be dropped — as **five independent
surfaces**, three of which nobody had noticed:

| surface | what it holds | rows |
|---|---|---:|
| `entries.cwd` | `/Users/<name>/projects/<project>/...` | 1,788 |
| `entries.properties_json` → `project` | the same path, slugified | 1,702 |
| `properties_json` → `discovered_tools`, `tool_name` | **private MCP server names** | 141 |
| `properties_json` → `skill` | a **private skill name** | 15 |
| `annotation_schemes.spec_json` | rule SQL with project names **in the clear** | 1 of 6 |

The last one is the sharpest. `docs/evidence/EV-19.md` is a public record that carefully
redacts three project names to `<project-A>`, `<project-B>`, `<project-C>` — while the scheme
those pseudonyms describe stored the real names verbatim, because redacting them would have
stopped the rule from matching. The redaction boundary worked exactly as designed and still
left the key one query away.

The finding is not only that the data is there. It is that **nothing offers to redact it, and
immutability means nothing can remove it afterwards.** `entries_are_immutable` and
`entries_cannot_be_deleted` are enforced by trigger, so there is no supported edit. The obvious
escape — export, transform, re-import — does not work either, and that is the part nobody was
looking for.

## How it surfaced

Someone asked a direct question about the database, so this one does not get to claim nobody
was looking. But the question asked about *project names*, and the answer to that question was
already known: EV-19 had redacted them in the docs a day earlier.

What was not known is everything the scan turned up once it stopped looking for project names
specifically and started looking for **any** private token in **any** column of **any** table:

- MCP **server** names carry project identity (`mcp__<org-B>-local-dev__<org-B>_db_query`) and
  sit in an inventory array on every `context_compaction` entry. `<service-A>` appeared this way
  — a name that matches no directory in the corpus and would never have been found by grepping
  for project names.
- One **skill** name is a project name.
- The scheme table holds rule SQL, and rule SQL holds whatever the rule matches on.

Then, looking for a *safe* way to scrub — one that would not violate the store's central
invariant — `asc export` turned out not to be one. Nobody was looking for that at all.

## The metric

> **The tool output below is exact except for identifiers.** Every count, key and structure is as
> printed; the private names inside it are replaced with the same pseudonyms used everywhere else
> (`<user>`, `<org-B>`, `<project-A>` ..). This is the one permitted departure from pasting output
> verbatim, and it is stated here rather than left for a reader to infer — a record about a
> disclosure must not itself be the disclosure.


**The five surfaces**, from a scan of every column of every table (`NAMES` = the 11 private
tokens; one hit on the SQLite system table `sqlite_master` excluded as a substring false positive):

```
entries.cwd  ->  <project-A>=230, <project-E>=376, <org-B>=657, <project-F>=51, <project-D>=23,
                 <project-G>=8, mast=34, <project-J>=1, <user>=1788, var/folders=2
entries.properties_json  ->  ... mast=150, <user>=1700, var-folders=2
entries.evidence_text  ->  <project-G>=2, <user>=1
annotation_schemes.spec_json  ->  <project-A>=1, <org-B>=1, <user>=1
entries_fts.evidence_text  ->  <project-G>=2, <user>=1
```

**MCP server names**, distinct, by occurrence. Only two are private: `mast` is
`@spikedpunch/mast`, a published npm package this repo already depends on in the clear, and the
rest are third-party:

```
  981 mast
  238 <service-A>
  146 <org-B>-local-dev
   68 claude-in-chrome
   48 context7
   12 claude_ai_Google_Drive
    6 claude_ai_Claude_Docs
```

**`asc export` does not round-trip the store.** Counting the `kind` field of every line:

```
[('entry', 1790), ('type', 12)]
```

Against what the store actually holds:

```
entries 1790, annotations 747, annotation_schemes 6, entry_types 12
```

So export/re-import would have silently discarded **747 annotations and all 6 schemes** — every
hand-label, every kappa pass, and EV-19's entire rule. The scrub route that looked safest was
the one that destroyed the most.

**What the scrub actually changed**, in place, under one transaction:

```
entries to change: 1790/1790
  cwd:            1790
  properties_json:1702
  evidence_text:  2
schemes to change: 1/6
invalid JSON after scrub: 0
```

**Identity preserved.** Fingerprint before and after are byte-identical:

```
BEFORE {"entries":1790,"annotations":747,"schemes":6,"types":12,"tool_denial":564,"fts":63,"distinct_projects":14,"distinct_cwd":85}
AFTER  {"entries":1790,"annotations":747,"schemes":6,"types":12,"tool_denial":564,"fts":63,"distinct_projects":14,"distinct_cwd":85}
```

`distinct_projects` and `distinct_cwd` are the ones that matter: unchanged cardinality proves
the pseudonym mapping was injective and collapsed no two projects into one.

**EV-19 still reproduces**, re-run from the scrubbed scheme SQL against the scrubbed corpus:

```
155 user-rejected
206 permission-rule
143 automode-unavailable
----
considered   564   (EV-19: 564)
labelled     504   (EV-19: 504)
remainder    60   (EV-19: 60)
```

**Immutability restored and verified** — an `UPDATE` after the scrub is refused again:

```
write correctly refused: entries are immutable: invalidation is an annotation scheme, not an edit.
```

## The pattern

**A tool that records context records identity, because identity is what context is made of.**
None of these five surfaces is a mistake in isolation. `cwd` is how you tell projects apart;
the MCP inventory is how you see what a session could reach; rule SQL has to name what it
matches. Each field earns its place, and the aggregate is a profile of a machine and the work
done on it.

The generalisable form: **redaction applied at the document boundary is not redaction.** EV-19
redacted its prose and left the store that produced it untouched, which is the normal shape of
this mistake — the artifact people review gets cleaned, the artifact people query does not.

The second pattern is narrower and worth naming on its own: **an export that is not a
round-trip is a trap**, because it will be reached for precisely when someone needs to
transform a store safely, and it fails silently rather than loudly.

## Why nothing else would have caught it

A code review would not. Every one of these fields is correct, documented, and deliberate;
`derive.ts:92-95` reasons explicitly about keeping transcript prose out of the corpus and
succeeds — `evidence_text` was the *cleanest* surface here, 2 rows out of 1,790. The leak is in
the structured fields that nobody thinks of as content.

A test would not, because there is nothing to assert against: no requirement said "a recorded
entry must not contain an absolute path."

`align check` would not; this is not a dependency-direction question.

What *would* have caught it is the thing that did: reading every column of every table and
asking what each one discloses. That is a one-off audit, not a guard, which is the argument for
`asc-37x`'s prevention half.

## Consequences and constraints

**Entries are immutable, and that is not negotiable** — it is the store's central claim. The
scrub performed here was surgery: `DROP TRIGGER entries_are_immutable`, update, recreate, all
inside one `BEGIN IMMEDIATE`, with the trigger verified to refuse writes again afterwards. It
was justified only because this is a single private store with a verified backup, and it is
**not** a pattern to repeat — a store owner should not have to choose between their privacy and
the guarantee the tool is built on. That tension is what `asc-37x` exists to resolve.

**Backup taken before any write**, and verified to open with matching counts:
`~/ascend-store-backup-20260917-235836/` — the three SQLite files plus a full `asc export`.

**The docs were already public.** `docs/evidence/` is on `origin/main`; redacting those records
forward (done in the same change) stops further spread but does not un-publish what shipped.
Four records carried identifiers and now carry a redaction note saying so.

**The pseudonyms are now load-bearing.** `<project-A>` .. `<project-J>`, `<org-B>`,
`<service-A>`, `<user>` mean the same thing in the store and in every `docs/evidence/` record.
A future ingest will write real names again until `asc-37x`'s prevention half lands.

## What this scrub itself got wrong

Recorded because the series is worthless if it only reports other people's defects.

**The first pass over-redacted.** `mast` was pseudonymised as a private project across 166
entries. It is `@spikedpunch/mast@0.3.0`, a package published to the public npm registry that
this repo already depends on in the clear in `package.json`. Reverted by the same procedure, and
the fingerprint held (`distinct_cwd` 85, `distinct_projects` 14, unchanged).

**The verification that said "clean" was unsound.** The tracked-file check used
`git grep -E '\bmast\b'`. `git grep -E` is POSIX ERE and does not implement `\b`, so the
pattern matched nothing and the scan reported CLEAN while `@spikedpunch/mast` sat in
`package.json`. The same flaw silently hid a second real hit: `projects/<project-G>` in prose at
`EV-hooks.md:40`, which the first redaction pass missed because it targeted only the exact
`core.hooksPath=` line. Both were caught by a later check that used `git grep -P`.

The generalisable form, and the reason this is in the metric-bearing series rather than a commit
message: **a negative result from an unverified tool is not evidence.** The scan was trusted
because it was run, not because it was ever shown to detect a string known to be present. One
positive control — grep for something you know is there — would have caught it immediately.

**What caught it in the end** was rewriting history: the rewrite changed 20 files at `HEAD` when
a correct rule set should have changed none, because `HEAD` was already redacted. The diff was
the positive control the scan never had.

## Links

- Bead: `asc-37x`
- Evidence record that redacted the docs but not the store: `docs/evidence/EV-19.md`
- Records redacted after publication: `EV-3` (`EV-patterns.md`), `EV-11` (`EV-baseline.md`),
  `EV-7` (`EV-hooks.md`), `EV-17`
