# Spike asc-igg8 — findings

Questions, predictions and method were frozen in `PREREG.md` before any of Q1–Q4 ran. Every figure
below is verbatim tool output. Two predictions failed; both are reported as failures.

Both scripts are read-only against the corpus. Nothing here was copied out of the transcript store.

**One thing `PREREG.md` claims that does not exist.** Its "Input, frozen" section says *"Manifest at
freeze: 132 files, sizes recorded by `manifest.json` beside this file, sha256 over the sorted
`name<TAB>size` list."* **There is no `manifest.json`.** Generating one requires stat-ing every file
in the transcript store, and that enumeration was **denied by the permission classifier**, twice (the
second attempt was the retry the denial itself suggests). `PREREG.md` is the frozen pre-registration
and is not edited after the fact, so the correction lives here: **the freeze is the cutoff instant
alone, and the file list is not recorded.** The file count in the output above (132) is what the run
itself observed, which is a weaker artifact than a manifest — it is a count, not a list, so it cannot
show *which* file changed between runs. This is the second way (after deletion, already stated in
`PREREG.md`) that a later re-run could differ without anything detecting it.

## Q1 — what the retained shape costs

`node spike/event-log/cost.mjs`, scope = every transcript line with `timestamp <= 2026-10-03T09:08:02Z`:

```
scope     : ts <= 2026-10-03T09:08:02.000Z
corpus    : 132 files, 105216 lines, 459944234 bytes

shape                     inputs        raw       gz   gz/corpus
i   full tool inputs     27462   29276075  6221485   1.353%
ii  slim (argv<=4)       27462   22043834  4404292   0.958%
iii full, redacted       27462   29275995  6221477   1.353%
```

**The unit caveat, stated because it flatters the result.** `gz/corpus` divides a *gzipped* log by
*uncompressed* transcript bytes. A like-for-like comparison would gzip the transcripts too, and the
share would rise by the transcripts' compression ratio. **This spike did not measure that ratio**
(the sampling run was denied by the permission classifier and was not re-attempted), so the honest
statement is: 6.22 MB gzipped against 460 MB of raw text, and the compressed-to-compressed share is
**not measured**.

Shape (iii) is byte-for-byte within 80 bytes of shape (i) — see Q-d below for why redaction is so
cheap in bytes and so expensive in consequence.

## Predictions against results

| # | predicted | measured | verdict |
|---|---|---|---|
| P1 | shape (i) gzipped **under 5 MB**, under **1%** of corpus | **6,221,485 B (6.22 MB)**, **1.353%** | **FAILED, both halves** |
| P2 | redaction removes **< 5%** of full-input bytes | 80 bytes of 29,276,075 = **0.00027%** | passed (vacuously — see below) |
| P3 | concurrent appends tear above a size threshold | **yes, from 8 KiB**, but the threshold is not a size (see Q3) | passed, for a different reason than predicted |
| P4 | no transcript deletion observable | **none observable**; oldest transcript is 37.1 days and present | passed |
| P5 | the carried figure is not reproducible | **not reproduced** (Q4) | passed |

**P1's miss is the load-bearing one.** I predicted 5 MB from `asc-bolz`'s slim-log rate of 0.545% gz,
on the reasoning that full inputs are a superset and "the same order". They are not the same order of
*share*: the slim log's 0.545% is slim-log-gz over its own corpus, and the corpus here is 460 MB over
a wider span. The error is the one the bead itself makes — carrying a ratio measured on one scope
onto another scope. **A prediction built from a carried ratio fails the same way the carried figure
does.**

**P2 passed vacuously, and the vacancy is the finding.** Predictions are usually allowed to pass; this
one should not be read as support, because the number it returned is not the number the question was
about (see Q-d).

## Q2 — is transcript expiry observable?

Read-only, machine-wide over `~/.claude/projects` (188 project directories):

```
projects total: 188 | machine-wide oldest transcript: 2026-08-27T06:45:13.557Z
age of machine-wide oldest: 37.1 days
```

Configured retention: **none**. `~/.claude/settings.json` and `settings.local.json` contain no
`cleanupPeriodDays` and no expiry-related key.

The oldest transcript on this machine is **37.1 days old and still present** — past the ~30-day
default the bead cites. This project's own directory spans **2026-09-12 .. 2026-10-03 (21 days by
mtime)**; the bead's and the spike's "~35 days" is not this project's span and appears to be no
project's span on this machine.

**What this does and does not show.** It shows expiry has not fired on this machine. It does **not**
show expiry cannot: the sweep could be disabled by configuration, or the documented default could
differ from the code's. The premise is **unproven, not false**, and a 21-day project cannot observe a
30-day boundary at all — `ascend` has never held a transcript long enough to test it. `P4` holds on
the evidence available and the evidence available is weak by construction.

## Q3 — do concurrent appends to one file interleave?

`node spike/event-log/append-race.mjs`: **8 concurrent appenders × 3 repeats per cell**, lines written
at an exact known length with their own trailer so a torn line is detectable without printing
payloads. Four writer styles, because the question is not whether `O_APPEND` tears but **how many
`write()` calls the writer makes**:

```
mode      line size   runs   lines/expected      torn
single        1024      3   320/320 320/320 320/320    0   3/3 intact
single        8192      3   320/320 320/320 320/320    0   3/3 intact
single       65536      3   128/128 128/128 128/128    0   3/3 intact
single      262144      3   32/32 32/32 32/32         0   3/3 intact
single     1048576      3   32/32 32/32 32/32         0   3/3 intact
chunk         1024      3   320/320 320/320 320/320    0   3/3 intact
chunk         8192      3   320/320 320/320 320/320    0   3/3 intact
chunk        65536      3   128/128 128/128 128/128   50   0/3 intact
chunk       262144      3   31/32 32/32 32/32        13   0/3 intact
chunk      1048576      3   32/32 32/32 31/32        52   0/3 intact
cat           1024      3   320/320 320/320 320/320    0   3/3 intact
cat           8192      3   320/320 320/320 320/320   71   0/3 intact
cat          65536      3   128/128 128/128 127/128  238   0/3 intact
cat         262144      3   32/32 32/32 32/32        73   0/3 intact
cat        1048576      3   32/32 32/32 32/32        96   0/3 intact
byte          1024      3   320/320 319/320 320/320  959   0/3 intact
byte          8192      3   320/320 320/320 320/320  960   0/3 intact

single        0 torn line(s) total; no tearing at any size tested
chunk       115 torn line(s) total; first tears at 65536 B (64 KiB)
cat         478 torn line(s) total; first tears at 8192 B (8 KiB)
byte       1919 torn line(s) total; first tears at 1024 B (1 KiB)
```

**`cat >> file` — the literal mechanism the bead proposes — tears from 8 KiB, and it tears in every
single repeat at 8 KiB and above.** `single`, one `writeSync` of the whole payload, never tore, at any
size up to 1 MiB. So the safety property is not "payload under N bytes"; it is **one `write()` call
per line**, and `cat`/buffered writers do not provide that above their buffer size.

Three things this changes about the risk as written:

- **The window is not a size.** `chunk` tore at 64 KiB and not at 8 KiB in this run — because its
  payload crosses the 64 KiB chunk boundary at different line counts. What matters is the number of
  `write()` calls, which a threshold in bytes cannot express.
- **The corruption is intermittent, not deterministic.** `chunk` at 8192 B produced **4 torn lines in
  the first run and 0 in the second**, same code, same machine. An intermittent corruption is worse
  than a constant one: it survives every test that does not happen to hit it.
- **It is silent.** Line counts frequently matched expectations exactly (`32/32`, `320/320`) while
  the content was torn — the file looks complete and parses as garbage. That is the
  severity-zero shape, and it is why this belongs in the (a)–(d) decision rather than in a follow-up.

**Limitations.** One machine, one filesystem (APFS), macOS 25.3. A single `write()` being atomic for
a regular file under `O_APPEND` is **not guaranteed by POSIX** — it is observed here, and the standard
only promises atomicity of the offset, not of the data. 3 repeats per cell is a small n for the
negative result on `single`; it is enough to say no tear was observed, not that none is possible. The
`byte` arm is capped at 8 KiB because one syscall per byte at 1 MiB is 32M syscalls, which is how the
first run of this probe was killed at 600 s having produced no output at all.

## Q4 — is the carried 16,380,630 figure reproducible?

```
--- Q4: the carried figure ---
bead note 6 (carried):     16251    16380630  3937484   (no recoverable source)
i   full tool inputs     27462   29276075  6221485   raw 1.787x gz 1.580x of carried
ii  slim (argv<=4)       27462   22043834  4404292   raw 1.346x gz 1.119x of carried
iii full, redacted       27462   29275995  6221477   raw 1.787x gz 1.580x of carried
```

**Not reproduced, from any scope constructible from the retained corpus.** The closest shape — slim,
which is what `asc-bolz` actually built — is still 1.35× the carried raw bytes over **27,462 inputs
against the carried 16,251**. No scope this spike could construct yields 16,380,630.

The correct order of magnitude and the wrong number is the signature of a carried figure: it was
plausibly real once, on a scope nobody recorded, and it has been re-quoted since as *"a measurement
rather than an estimate"*. `P5` holds.

## Q-d — the redaction number, and a correction to what was already reported

`cost.mjs` reports **3 of 27,462** blocks changed by redaction. That was implausibly low against the
already-measured all-projects rate of 862 of 149,634 (0.576%, which predicts ~158 here), so it was
broken down by project:

```
project                          blocks   hits   sess  hitSess
-…-projects-grizzly-grizz...      37863    618     13        6
-…-projects-grizzly-grizz...      49749    209      9        7
-…-projects-saul                   5901     14     1        1
-…-projects-ascend                27472      6      9        4
-…-projects-spindle               17318      6      1        1
-…-projects-grizzly-grizz...       5013      5      1        1
-…-projects-grizzly-grizz...       3776      4      2        1
projects with any tool_use: 164
TOTAL blocks 150337  hits 862  (0.573%)
```

**97% of the 862 matches are `grizzly` directories, not `ascend`.** The figure I gave earlier —
*"9.09% of sessions (21 of 231)"* — pooled 164 projects, and a per-project log carries only its own
project's text. For `ascend` the incidence is **6 blocks of 27,472 (0.022%)**, across **4 of 9
sessions**.

**This weakens the framing and not the conclusion.** The (d) risk was argued from frequency; the
frequency is largely other projects'. But `asc export` **refuses the whole export on a single match
with no override** (`asc-42i1`), and entries are immutable so the text cannot later be removed — so a
0.022% per-block rate is a rate at which a project gets bricked, not a rate at which it gets slightly
dirtier. Four of nine `ascend` sessions carry at least one. The conclusion stands on the
one-is-fatal clause, not on the rate.

**The 6-versus-3 gap is not fully explained.** The per-project scan tests `JSON.stringify(input)` as a
whole and applies no timestamp cutoff; `cost.mjs` applies `redact()` per string value within the
cutoff. Either could account for a 3-block difference out of 27,462. It is reported rather than
resolved because both numbers are effectively zero and chasing three blocks would buy nothing — but
**two methods disagreeing should not be quietly averaged**, and this is the one number in this spike
that is reported without being understood.

## (a)–(d): the bead's four open questions, measured where they can be

The owner chose to design on measured numbers, so each open question was taken as far as the evidence
carries it. Two are answered outright; two are answered for today's handlers only.

### (a) Which events are in scope — **12 of 14 `EVENT_KINDS` are required**

Measured over the seven handlers in `./handlers/`, reading every `on:` (including the nested window
triggers) and every `until:`:

| role | kinds |
|---|---|
| top-level trigger | `file.changed` ×3, `file.read`, `review.finding`, `agent.spawn`, `tool.use.start` |
| window trigger / second trigger | `check.run` ×2, `command.run`, `search.run`, `agent.return`, `model.context` |
| window bound (`until:`) | `session.end` ×2, `prompt.submit` ×2 |

`check.run`'s role is load-bearing rather than incidental: `read-unused`, `edit-verified` and
`edit-unverified` all emit *at* it, and the windows they open end at `session.end` / `prompt.submit`,
so those bounds must be retained for the window to close at all — an `until` is a retention
requirement even though no handler *keys* on it.

**Referenced by nothing: `tool.use.end` and `segment.start`.** No handler mentions either, and no
handler references `is_error` (a `tool.use.end` field) or `segment`. So the honest answer to (a) is
**not** "only the five kinds a handler triggers on" — that would silently drop five more that windows
need — and it is **not** "all fourteen".

### (b) The byte cap — the mechanism exists, the policy does not

Measured growth: **29,276,075 raw over a ~22-day content span ≈ 1.33 MB/day raw, ≈ 0.28 MB/day gz**
(6,221,485 gz / 22). Against `asc-8uzh`'s `MAX_BYTES_PER_FILE = 20 MiB`, that is **~15.8 days per
file** — and rollover **appends a new higher-index file and never drops**; no drop-oldest code exists
anywhere in `packages/store/src`. So the cap does not bound the log, it bounds a *file*, and the log
grows ~1.3 MB/day without limit unless a drop policy is chosen. **That is the decision (b) actually
poses**, and it is now arithmetic rather than a worry.

The hazard the bead names for it is real and unchanged: drop-oldest silently is a count that moves for
a reason no handler changed — the `derive_version` hazard in reverse.

### (c) Per project or per user — **per project, on the Q-d measurement**

A per-user log pools every project's text. The measured concentration: `ascend` contributes **6 of
27,472** secret-shaped blocks while four `grizzly` directories contribute **836 of 93,401** — 97% of
all matches. `asc export` refuses the whole export on **one** match with no override (`asc-42i1`) and
entries are immutable, so pooling imports other projects' refusal risk into this project's log for no
benefit this project can use.

### (d) Store type or its own file — **the per-record cap is not a blocker**

`spike/event-log/record-size.mjs`, same scope and cutoff, envelopes built as the deriver would:

```
events            : 27462
store per-record cap: 1048576 B (MAX_BYTES_PER_RECORD, refused not rolled)
max               : 60289 B
p99.9             : 21448 B
p99               : 9657 B
p50               : 431 B
over the cap      : 0 of 27462
max / cap         : 0.057x
```

**The largest event is 5.7% of the cap and nothing exceeds it**, so a store type can hold these events
without meeting `asc-8uzh`'s refusal. (d) therefore does **not** turn on the size limit — the reason
to prefer one shape over the other has to come from somewhere other than this measurement. Limitation:
n = 1 project; a corpus of large file reads could produce a bigger event than `ascend` ever has, and
this measures `ascend` only.

### The bead's open item (2) — `tool_response` is **not required**

`asc-igg8`'s note says *"if tool_response is retained the byte cap has to be sized against it, which is
the one number that decides whether (a) above is affordable"*. Measured: **no handler references
`tool_response`**, and it is not a field of any declared `EVENT_KIND` — `tool.use.end` carries `tool`,
`id`, `role`, `is_error` (`event.ts:64`), and `duration_ms` rides on `agent.return` (`:116`), which
*is* needed. So the number that was said to decide (a)'s affordability **does not need to be measured
for any handler that exists today**: capture can normalize without `tool_response` and the Q1 cost
basis stands. If a future handler wants output bodies, this reopens — and that is the honest boundary
of the claim.

