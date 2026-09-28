# 0024 — editing a typed handler leaves its previous version's entries counted beside the new ones

| | |
|---|---|
| **Bead** | `asc-w8tx` |
| **Surfaced** | 2026-09-27 |
| **Surfaced by** | measuring the section join for `asc-tuur.7` in a scratch store, then asking what the same change does to the live one |
| **Entry type(s)** | `review_finding` (derived, via a typed handler) |
| **Severity** | P2 |
| **Status** | fixed: live rows invalidated 2026-09-27 (47 of 47); ingest now warns, in the commit that adds **Resolution** |

## What was found

An **absence**. A typed handler's entry key carries its hash (`typed-handlers.ts`), so any change
of meaning proposes new ids. That part is by design, and the deriver works the same way
(`DERIVATION_VERSIONS`). What is missing is the second half: nothing retires the old version's
entries, and nothing says they are still open. After a handler edit, one finding is counted once
per handler version that read it.

## How it surfaced

The scratch-store measurement for `asc-tuur.7` printed `review-finding-table@32ed6b834377` in
its ids, and the live store's rows are keyed `@66f77c9fba90`. **Nobody was looking for it.** The
question was only whether the new handler wrote more rows. The deriver's version of this problem
was handled for `skill_activation` by a hand-run migration (`dogfood/0020`), which is why the id
shape was recognisable at all.

## The metric

Live store, through `asc query` (read-only), parsed `review_finding` rows by handler version:

```
[{'n': 47}]
```

All 47 are keyed `review-finding-table@66f77c9fba90`. The scratch ingest of the same corpus with
the edited handler wrote 65 under `@32ed6b834377`. Comparing the key after the hash, both sides
sorted, with `comm -12`:

```
      47
      65
      47
```

So every old row has a twin. The next live ingest would count **47 findings twice**: 112 rows
for 65 findings. That is 6 report Writes in 5 sessions, an anecdote, but the mechanism is not
specific to this handler.

## The pattern

**A versioned key without a retirement step.** Making the new version's ids distinct is what
keeps ingest idempotent. It also means "which version is current" is a question the store cannot
answer on its own, so every reader counts all versions.

## Why nothing else would have caught it

The typed-handler tests run one handler version per store. The migration that fixed the same
shape for `skill_activation` was a spike script, not a command, so it left no guard behind.

## Consequences and constraints

Entries are immutable, so the fix is an `invalidation` annotation (`asc invalidate --label
superseded --superseded-by <new id>`) per old row, or prevention: ingest noticing open entries
under the same handler name with another hash.

## Resolution

Both halves, as **Consequences and constraints** named them. Neither one writes to the store by itself.

- **The live store.** Each of the 47 old-hash rows was invalidated as `superseded` by its twin
  under the new hash. The run reported `wrote 47 failed 0`, after 47 of 47 dry-runs were OK.
- **Prevention.** `asc ingest claude-code` now counts the open entries of every typed handler by the
  hash in their key. For each version it is not running, it warns with the count and the
  `asc invalidate` command that retires them (`reportEarlierVersions`,
  `packages/cli/src/commands/ingest/claude-code.ts`). The test edits a handler and re-ingests, and
  expects the warning with a count of 2. It then invalidates both rows and expects no warning
  (`packages/cli/test/ingest-typed-handlers.test.ts`).
- **Checked.** A `--dry-run` ingest on the live store after the migration printed no such warning.

Retiring stays a decision the user makes, so the warning names the command and does not run it.

## Links

- Bead: `asc-w8tx`
- Related: `dogfood/0020` (the same shape in the deriver, migrated by hand)
