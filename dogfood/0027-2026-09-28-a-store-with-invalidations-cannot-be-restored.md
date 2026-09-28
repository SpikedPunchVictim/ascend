# 0027 — a store with invalidations cannot be restored from its own backup

| | |
|---|---|
| **Bead** | `asc-ax8c` |
| **Surfaced** | 2026-09-28 |
| **Surfaced by** | the scratch dry run for `asc-o3tn`, the first `export` → `import` of this project's whole store |
| **Entry type(s)** | none. The defect is in the `invalidation` annotation scheme |
| **Severity** | P1 |
| **Status** | fixed |

## What was found

`asc import` could not import a full `asc export` of any store that held even one
invalidation. The export writes the reserved `invalidation` scheme as an ordinary scheme line.
Import registered every scheme line through `registerScheme`, which refuses the reserved name to
any caller. The whole restore ran in one transaction, so the refusal wrote nothing. The command
the store documents as its backup had therefore never been able to restore this project's store.

The refusal message had a second, smaller fault. It still said the name was waiting for
`asc-88m` ("until then nothing may register under it"), but `asc-88m` had long since shipped
`asc invalidate`.

## How it surfaced

`asc-o3tn` rebuilds the store so that scrubbed derived rows can be re-derived. Its first step is
to export the live store and import that export into a fresh scratch store. The import failed at
that first step. Nobody was looking for it: the rebuild depended on the round trip working and
treated it as settled. `corpus.test.ts` did round-trip a whole corpus, but its fixture corpus
had no invalidations.

## The metric

The live store's export, counted by `kind`:

```
10,185 lines: 16 type, 6,274 entry, 7 scheme, 3,888 annotation
```

Of those annotations, 511 are under `invalidation`.

`asc import` of that file into a fresh `asc init` store, under the OS temp root. The message is
cut at the ellipsis; the rest of the line lists the registered schemes:

```
Error: 'invalidation' is a reserved scheme name: ARCHITECTURE.md makes invalidation an annotation scheme rather than an edit, so this name belongs to the store and must not mean a user's rules. The command that will use it is asc-88m; until then nothing may register under it. …
```

The command exited 1, and the scratch store held 0 entries afterwards.

## The pattern

When a refusal guards a name, it guards it at every entry point, and that includes the one that
replays the store's own writes. Two separate decisions were each correct on their own:

- `requireName` is never given an exception, so that no user scheme can take the name;
- `import` restores through the same public functions a user calls, so that a restore can never
  write something a user could not have written.

Together they meant a restore could not write something the store had written for itself. The
fix is a third caller that accepts the name only together with the store-owned shape,
`restoreInvalidationScheme`. Neither of the two rules is loosened.

## Why nothing else would have caught it

- The round-trip test's fixture had annotations but no invalidations.
- The `invalidate` tests never export.
- Nobody runs `asc import` against a real store until they need the backup, which is the moment
  this defect costs the most.

## Consequences and constraints

No data was lost, because the refusal wrote nothing. The fix adds two tests:

- a round trip that carries invalidations;
- a stream that tries to restore a widened shape under the reserved name, which is refused.

## Links

- Bead: `asc-ax8c`
- Found during: `asc-o3tn`
- Related: `asc-88m` (the command the stale message still waited for)
