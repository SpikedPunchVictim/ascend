# Spike asc-x1gw — a git-native JSONL layout: findings

Predictions were sealed in `PREREG.md` (sha256 `94989e1c…3e6561`, in the bead notes) before
anything ran. Input: `asc export` of this store, 4,725 records. Scratch repositories only. Git ran
with global and system config disabled (`GIT_CONFIG_GLOBAL=/dev/null`) and no hooks. Two full
runs gave identical results.

```bash
node packages/cli/dist/bin.js export > <scratch>/export.jsonl
node spike/git-layout/run.mjs <scratch>/export.jsonl <scratch>/gitlayout
```

**One harness correction, made before settling anything.** In the first run, the W rows counted
"lost" against the upstream records too. A pull that git *refused* therefore showed `lost 20`,
though nothing local was touched. The rerun adds `lostLocal`, the local uncommitted records
missing from the working tree. That is the clobber measure.

## Result

Branch scenarios, merge and rebase alike. Rebase gave the same result as merge in every one of the 24 pairs.

| layout | S1 disjoint | S2 shared ingest | S3 contradiction | S4 backdated |
|---|---|---|---|---|
| `one` | CONFLICT, naive loses 20 | CONFLICT, naive loses 10 | CONFLICT, naive loses 5 | CONFLICT, naive loses 5 |
| `one-union` | clean | clean, 0 dupes | clean, **1 silent contradiction** | clean |
| `sorted` | CONFLICT, naive loses 20 | CONFLICT, naive loses 10 | CONFLICT, naive loses 5 | clean |
| `day` | CONFLICT, naive loses 20 | CONFLICT, naive loses 10 | CONFLICT, naive loses 5 | clean |
| `writer` | clean | clean, **30 dupes** | clean, **1 silent contradiction** | clean |
| `entry` | clean | clean, 0 dupes | **CONFLICT (1 file), naive loses 0 records** | clean |

"Naive loses N" means `git checkout --ours` and `--theirs` each drop all N of the other side's
new records. In `entry`'s S3 conflict, a naive resolution keeps one of the two contents for the
contested id and loses no record.

Working tree: records appended and uncommitted, then an upstream change arrives.

| layout | W1 `pull` | W2 `stash; pull; stash pop` | W3 `pull --rebase --autostash` |
|---|---|---|---|
| `one`, `sorted` | refused, 0 lost | pop conflicts: **3 conflict-marker lines in the file**, stash kept | **exits 0**, with 3 conflict-marker lines in the file, stash kept |
| `one-union` | refused, 0 lost | ok, 0 lost | ok, 0 lost |
| `day` | refused (untracked new-day file), 0 lost | refused, 0 lost | refused, 0 lost |
| `writer`, `entry` | ok, 0 lost | ok, 0 lost (nothing to stash) | ok, 0 lost |

A's diff against base was **+N −0** in every layout (`day` touched 3 files in S4; `entry`
touched N files).

Cost:

| layout | scan all + filter | records on disk | `.git` after `gc` | `git status` |
|---|---|---|---|---|
| `one-union` | 22 ms | 4,144 KB | 480 KB | 0.05 s |
| `writer` | 19 ms | 4,140 KB | — | 0.05 s |
| `entry` | **781 ms** | 18,996 KB (4,725 files) | 2,616 KB | 0.04 s |

## Predictions, settled

| # | prediction | result |
|---|---|---|
| P1 | `one` conflicts in S1–S3, and a naive resolution loses all of the other side's new records | **confirmed** (S4 conflicts too) |
| P2 | `one-union`: 0 conflicts, 0 lost, S2 dupes > 0, S3 silent | **mostly confirmed; dupes FAILED: 0.** Git aligned the identical shared block. Other orderings were not tried |
| P3 | `sorted`: S1 conflicts, S4 clean | **confirmed** |
| P4 | `day`: S1 conflicts on the same day | **confirmed** |
| P5 | `writer`: 0 conflicts, 30 dupes, S3 silent | **confirmed** |
| P6 | `entry`: 0 conflicts in S1/S2/S4, 0 dupes, S3 loud | **confirmed** |
| P7 | every layout diffs +N −0 | **confirmed** |
| P8 | W1 on a single file is refused; W2 on `one` conflicts at pop | **confirmed** |
| P9 | a scan takes < 100 ms | **confirmed for single-file and grouped layouts (18–26 ms); FAILED for `entry` (781 ms)** |

## What it means

**A conflict in an append-only file is how data gets lost.** The records never really conflict,
because every scenario except S3 adds different lines. But git reports a conflict whenever two
branches append at the same place, and the resolutions people reach for first (`--ours`,
`--theirs`, "accept mine" in an editor) drop the other side's records entirely. `one`, `sorted`
and `day` all have that path. Keeping the file sorted by time does not help: S1–S3 still conflict,
because new records land at the end on both sides.

**The worst path is one that reports success.** `git pull --rebase --autostash` is a common
default. On a single file it exited 0 and left conflict markers inside `records.jsonl`, with the
local records sitting in the stash. The next `git add -A && git commit` commits a corrupted file,
and the records are only in a stash the user may never look at. Nobody was looking for this. The
scenario was there to check P8.

**Only `entry` has no silent path.** It had no conflict except on a real contradiction (S3), and
there it is loud: an add/add conflict on exactly the contested record, where either resolution
loses no record. It had no duplicates, because the same derived record is the same file on both
sides, and no working-tree hazard.

**`one-union` is the runner-up, and its gap can be closed by the read layer.** It never conflicts
and never lost a record. Its one silent path is S3: both contents kept under one id. A reader
that indexes by id and **refuses** one id with two contents (dogfood/0014's check, applied at
read time) turns that into a loud error. That also covers the orderings where union would
produce duplicates.

**The trade-off for diff review.** `one-union` shows a PR's records as +N lines in one file, in
write order. `entry` shows N new one-line files named by hash, so review reads a list of files. On
cost, `entry`'s 781 ms scan argues that option B's read layer should keep a derived, gitignored
index rather than scan the files, which it needs anyway to serve queries. Its repository costs
about 5× more (2.6 MB vs 0.5 MB packed) at this size.

## Recommendation

By the sealed decision rule (no silent loss or silent duplicate path; conflict only on a real
contradiction), **`entry`, one file per record**, behind option B's read layer with a derived,
rebuildable index. If single-file review diffs matter more than the loud contradiction,
**`one-union` plus a read-time contradiction check** is safe on every path measured here.

Both need, whatever else is decided:
- **ids**: UUIDv7 for hand-recorded records, deterministic ids for derived ones. S2's clean
  dedupe in `entry` depends on that.
- **a guard**: a check (pre-commit or CI) that refuses conflict markers or unparseable lines in
  record files, and that the ids at HEAD are a superset of each parent's. That catches the
  autostash path and any naive resolution.

## Limitations

- Synthetic branch contents from real record shapes. Two branches, one merge each. Octopus merges,
  cherry-picks and GUI merge tools were not tried.
- `one-union`'s 0 dupes holds for the tested orderings only.
- The size and scan figures are at 4,725 records. Growth (3,226 derived records in about 12 days)
  was not projected. The `entry` file count scales one to one with records.
- Identity: committed records leave the machine. Under the 09-20 ruling they would go through the
  `--redact` path, and that was not part of this spike.

## Addendum: files per directory at 100,000 records (asked after the spike, not pre-registered)

`node spike/git-layout/bench-scale.mjs <scratch> 100000`. One file per record, flat versus 256
shards (`records/<2 hex>/<sha256>.json`). Auto-gc was disabled for timing: at this size a plain
commit started a background `gc`, which is itself worth knowing. Exact output:

```
{"mode":"flat","files":100001,"writeFilesS":"12.4","gitAddS":"119.61","commitS":"1.64","statusS":"0.46","commitOneS":"1.04","recordsTreeBytes":9700097,"shardTreeBytes":"-","objectsChangedByOneRecord":2,"indexBytes":14400251,"packKB":25869}
{"mode":"shard256","files":100001,"writeFilesS":"12.5","gitAddS":"88.69","commitS":"1.41","statusS":"0.31","commitOneS":"0.22","recordsTreeBytes":7424,"shardTreeBytes":"36957","objectsChangedByOneRecord":3,"indexBytes":14407677,"packKB":25978}
```

- **Flat directory:** every commit that adds one record writes a new 9.7 MB tree object for
  `records/`. A one-record commit takes 1.04 s.
- **256 shards:** the same commit rewrites a 7.4 KB top tree and one 37 KB shard tree, and takes
  0.22 s.
- Index (14.4 MB), `git status` (0.3–0.5 s) and pack size (about 26 MB) barely differ. They scale
  with the total number of files, not with how the files are spread across directories.
- Adding 100,000 files at once took 89–120 s. That is a one-time cost, as in a migration. Clone
  and checkout at this size were not measured.

## Addendum: rolled-over files of 50,000 with `merge=union` (owner proposal, not pre-registered)

`node spike/git-layout/rollover.mjs <export.jsonl> <scratch>`. The writer appends to the newest
file and starts `records-000N+1.jsonl` once the newest holds 50,000. The base is 49,990 records.
Exact output:

```
base: 49990 records, 40.9 MB
append 5 to the 49990-record file: diff 0.87s (1 file changed, 5 insertions(+)), add 0.67s, commit 0.06s, new loose blob 5.3 MB, show 0.35s
R1 both roll over (A +30, B +30) merge: clean; lost 0, bad lines 0, dupes 0; files 0001:50010 0002:40
R1 both roll over (A +30, B +30) rebase: clean; lost 0, bad lines 0, dupes 0; files 0001:50010 0002:40
R2 only A rolls over (A +30, B +5) merge: clean; lost 0, bad lines 0, dupes 0; files 0001:50005 0002:20
R2 only A rolls over (A +30, B +5) rebase: clean; lost 0, bad lines 0, dupes 0; files 0001:50005 0002:20
R3 neither rolls over (A +4, B +4) merge: clean; lost 0, bad lines 0, dupes 0; files 0001:49998
R3 neither rolls over (A +4, B +4) rebase: clean; lost 0, bad lines 0, dupes 0; files 0001:49998
```

- Two branches creating the same new file (an add/add) merge cleanly under union.
- A merge can push a file past the cap (50,010). That is harmless as long as the writer counts
  the file's lines rather than assuming the cap.
- Every commit to a full file stores a new **5.3 MB** loose blob until `gc` packs it. Auto-gc
  triggers on the number of loose objects, not their size, so this can accumulate. That is a
  projection; only one commit was measured.
- Record size varies by type about 18× (payload averages: `verification_run` 228 B,
  `evidence_record` 4,151 B). A cap by count gives files of very different sizes.

## Addendum: bytes per record by type, at a 5,000-record cap (owner proposal, not pre-registered)

The owner proposed capping each file at about 5,000 records, to stay well clear of GitHub's
100 MB block, with one directory per record type. `node spike/git-layout/linesize.mjs
<export.jsonl> 5000`. Bytes include the newline. Exact output:

```
type	n	avgB	p99B	maxB	MB@5000avg	MB@5000max
evidence_record	24	4687	7858	7858	23.4	39.3
note	17	3129	6876	6876	15.6	34.4
type	14	2453	5116	5116	12.3	25.6
decision	73	2451	4940	4940	12.3	24.7
review_completed	4	2004	2421	2421	10.0	12.1
stuck_event	5	1880	2024	2024	9.4	10.1
search_miss	10	1464	2067	2067	7.3	10.3
user_correction	20	1328	3597	3597	6.6	18.0
context_compaction	654	966	1290	1484	4.8	7.4
stage_transition	31	937	2654	2654	4.7	13.3
tool_denial	612	767	836	863	3.8	4.3
verification_run	1836	754	806	832	3.8	4.2
skill_activation	104	749	809	809	3.7	4.0
annotation:invalidation	588	659	717	1168	3.3	5.8
annotation:shuffled-denial	80	377	390	390	1.9	1.9
scheme	7	366	673	673	1.8	3.4
annotation:hand-denial	80	358	367	367	1.8	1.8
annotation:rule-denial	504	349	358	363	1.7	1.8
annotation:hand_layer	6	260	261	261	1.3	1.3
annotation:by_kind	74	259	261	261	1.3	1.3
annotation:layer	3	255	256	256	1.3	1.3
lines 4746; over 20000 B: 0; over 10000 B: 0; largest 7858 B
```

- At 5,000 records the heaviest type is 23.4 MB at its average size, and 39.3 MB if every record
  were the largest one seen. Both are under GitHub's 50 MB warning.
- A file reaches 100 MB only when its records average 20,000 B. No record today exceeds 10,000 B.
- **Small n.** The heavy types are anecdotes: 24 `evidence_record`s, 17 `note`s. Their maxima say
  little about the tail.
- **Nothing bounds a record's size.** `evidence_text`, `measurement` and `note` are free text, so
  a single pasted log can be megabytes. A cap by count bounds a file only while records stay small.
  Hence the byte limit on rollover and the per-record limit in the decision below.
- Per-commit object size at 5,000 was not measured. Scaled from the 50,000-record row (5.3 MB for
  a 40.9 MB file), a full 3.8 MB `verification_run` file would store about 0.5 MB per commit.
  That is a projection.

## Decision (owner, 2026-09-24)

Records live in git as JSONL:
- one directory per type, with annotations in a directory per scheme;
- append-only files, rolled over at 5,000 records or about 20 MB, whichever comes first (the
  writer counts actual lines, since a merge can push a file past the cap);
- `merge=union` on the record files;
- UUIDv7 ids for hand-recorded records, and deterministic ids for derived ones;
- order by `(recorded_at, id)` when reading, never by rewriting files;
- all of it behind the option-B storage-neutral read layer, with a derived, rebuildable index.

Required with it:
- a read-time check that refuses one id with two contents;
- a guard (pre-commit or CI) against conflict markers and unparseable lines, requiring that ids
  at HEAD are a superset of each parent's;
- a per-record size limit at write time;
- a check that GitHub's merge button and common GUI clients honour `merge=union`.

The alternative, `entry` (one file per record), had the only fully loud contradiction path. It
lost on review diffs (N hash-named files per change) and on scan cost (781 ms at 4,725 records against 22 ms).
The read-time check closes `one-union`'s one silent path.
