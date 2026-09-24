# Spike asc-x1gw — a git-native JSONL layout: pre-registration

Written 2026-09-24 before anything ran. Sealed by sha256 in the bead's notes.

**Goal (owner):** the records live in git as JSONL. Diffs must be readable, and a normal git workflow
must not clobber data, meaning it must not lose, silently duplicate, or silently overwrite a record.

**Input:** `asc export` of this store (4,746 lines: 21 type definitions, 7 schemes, 3,390 entries,
1,335 annotations). Entries and annotations are both immutable records with an id and a timestamp.
Every scratch repository is built from it, and nothing is committed to this repo.

## Layouts

| name | files |
|---|---|
| `one` | a single `records.jsonl`, appended in write order |
| `one-union` | the same, with `records.jsonl merge=union` in `.gitattributes` |
| `sorted` | a single file kept sorted by (timestamp, id) |
| `day` | `records/YYYY-MM-DD.jsonl`, by the record's timestamp |
| `writer` | `records/<writer>.jsonl`, one per clone; the base data is under `origin` |
| `entry` | one file per record, `records/<sha256(id)[0:2]>/<sha256(id)>.json` |

## Scenarios (branches A and B from one base, then B merged into A, and separately A rebased onto B)

- **S1 disjoint**: A and B each add 20 hand entries (UUIDv7, the same day).
- **S2 shared ingest**: both add the same 30 derived entries (the same transcript ingested on two
  clones), plus 10 of their own each.
- **S3 contradiction**: both add derived id X with different content (dogfood/0014's shape),
  plus 5 of their own each.
- **S4 backdated**: A adds 5 entries whose timestamps fall inside the base's range (an import, or
  clock skew). B adds 5 at the end.

When a merge conflicts, each naive resolution is applied (`--ours`, then `--theirs`), and the
records it loses are counted.

**Working tree (W):** records appended but uncommitted, then (W1) `git pull` of an upstream change
to the same layout, and (W2) `git stash && git pull && git stash pop`.

## Measured per (layout, scenario, strategy)

- conflict yes/no;
- after the merge: records lost, exact duplicates, and silent contradictions (one id, two contents);
- under a naive resolution: records lost;
- A's diff against base: lines added and deleted (the ideal is +N −0) and files touched.

## Questions and predictions

| # | prediction |
|---|---|
| P1 | `one`: S1, S2 and S3 conflict. A naive resolution loses **all** of the other side's new records. |
| P2 | `one-union`: **0** conflicts in S1–S4 and 0 lost, but S2 leaves **> 0** exact duplicates, and S3 keeps both contents **silently**. |
| P3 | `sorted`: S1 conflicts. S4's backdated insertions merge clean when they are not next to B's changes. |
| P4 | `day`: S1 conflicts when both branches write the same day, which is the common case. |
| P5 | `writer`: **0** conflicts in S1–S4. S2 leaves 30 cross-file duplicates, which reads must dedupe. S3 is silent. |
| P6 | `entry`: **0** conflicts in S1, S2 and S4, and 0 duplicates in S2 (the identical file was added on both sides). S3 is an add/add **conflict**: the only layout where a contradiction is loud. |
| P7 | Every append layout diffs as +N −0. `sorted` also diffs as +N −0 (an insertion, not a rewrite). |
| P8 | W1 with a single file: git **refuses** the pull (the local change would be overwritten), so nothing is lost. W2 on `one` conflicts at `stash pop`. |
| P9 | Scanning all 4,725 records from JSONL and filtering by type takes **< 100 ms**, so a scan backend is viable at this size. |

## Decision rule

Prefer the layout with **zero silent-loss or silent-duplicate paths** across S1–S4 and W. Among
those, prefer the one that conflicts only on a real contradiction (S3). A layout that needs
duplicates removed on read is acceptable only if reads dedupe by id and treat one id with two
contents as an error.
