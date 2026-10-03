# Spike asc-igg8 — what an ascend-owned event log costs, and whether it is needed

Written 2026-10-03T09:08:02Z, before Q1's byte measurement over the full manifest, and before Q2, Q3
and Q4. `asc-igg8` is a P1 whose justification is a premise chain, and the spine of it turned out to
be unmeasured; this spike exists to measure the spine rather than design on it.

## Why this spike exists

`asc-igg8` asks for a retained event log because *"transcripts expire (~30 days), so every handler
count replayed from them is a count over a shrinking window"*, and it prices that log at
**16,380,630 bytes raw / 3,937,484 gz for all 16,251 tool inputs in this project's ~35 days**,
calling that figure *"a measurement rather than an estimate"* and *"the whole argument for the cost"*.

An audit of that figure on 2026-10-03 found no recoverable source for it: it appears only in the
`asc-6ola` note that cites it and in a model-written compaction summary. It is not in
`spike/replay/FINDINGS.md`, not a field `spike/replay/replay.mjs` emits, not in git history, and not
in any `.ascend` entry. A first reproduction attempt got **12,220,175 raw / 2,982,822 gz over 11,136
inputs**, on a scope that did *not* match the spike's (4 files / 171,977,519 B / 11.2 days against
the summary's 77 files / 269,227,919 B / ~35 days) — so it neither confirmed nor refuted it.

## Already measured — NOT predictions

Recorded here so that nothing below can be presented as having been predicted when it was known.

- **Secret-shaped incidence in retained content.** Of **149,634** `tool_use` input blocks across the
  whole corpus (231 sessions), **862 (0.576%)** match a pattern in `SECRET_PATTERNS`; **21 of 231
  sessions (9.09%)** contain at least one. Almost all are `Bash` (807 of 862) and almost all are
  `secret-assignment` (796). Measured with the shipped patterns from `packages/cli/dist/secrets.js`.
- **The failed reproduction above** — 12,220,175 / 2,982,822 over 11,136 inputs, scope not matched.
- **Corpus span.** This project's transcript directory spans **2026-09-17 .. 2026-10-03 (16 days by
  mtime; the oldest file's first internal event is 2026-09-11, so ~22 days of content)**. The
  "~35 days" the bead and the spike both cite is not this project's span.

## Input, frozen

`~/.claude/projects/-Users-spikedpunchvictim-projects-ascend`. **Freeze is a manifest, not a clone.**
`asc-bolz` cloned the store with `cp -cR`; that copy was declined here by the permission classifier
(the source is the user's real session store and the destination was inside the repo tree), so this
spike reads the live directory in place and instead pins scope by **cutoff instant**:

> **Scope = every transcript line whose `timestamp` is <= 2026-10-03T09:08:02Z.**

Each line carries its own timestamp, so lines written after the freeze — by this very session — are
excluded by construction. That is what makes the measurement stable without a clone, and it is
**weaker than a clone** in exactly one way: a file deleted between the freeze and a later re-run
would change the answer, and nothing detects that. Stated, not hidden.

Manifest at freeze: **132 files**, sizes recorded by `manifest.json` beside this file, sha256 over
the sorted `name<TAB>size` list.

## Questions

- **Q1** What does the retained shape cost, raw and gzipped, over the frozen scope? Three shapes,
  because they are three different products: **(i) full tool inputs**, output bodies dropped, which is
  what note 6 asks for; **(ii) slim** (`argv` cut to 4, no bodies), which is what `asc-bolz` actually
  built and measured; **(iii) full inputs with secret-shaped values redacted at capture**, to price the
  mitigation Q3-of-the-bead's (d) appears to require.
- **Q2** Is transcript expiry observable at all — has anything been deleted, and what is the real
  retained span? The premise the whole bead rests on.
- **Q3** Do concurrent appends to one file interleave once the payload exceeds the atomic write size?
  The exposure addendum calls this "Unmeasured"; the failure is silent, which is why it matters.
- **Q4** Is the carried 16,380,630 figure reproducible from any scope constructible from the retained
  corpus?

## Predictions

| # | prediction |
|---|---|
| P1 | The full-input shape (i), gzipped, is **under 5 MB** for this project — under **1%** of the transcript bytes it came from. `asc-bolz`'s slim log measured 0.545% gz; full inputs are a superset and should be larger but of the same order. |
| P2 | Capture-time redaction removes **less than 5%** of the full-input bytes. The matches are rare in bytes (862 blocks) even though they are present in 9% of sessions, because a secret is a few dozen bytes inside a command that may be kilobytes. |
| P3 | Concurrent appends **DO interleave** above a payload threshold, so an `async: true` shell append with no lock is unsafe for large payloads — and the corruption is silent. Below the threshold, no interleaving. |
| P4 | **No transcript deletion is observable.** Every file present at the oldest retained date is still present; the 30-day expiry is a documented default that has not demonstrably fired on this machine. If this holds, the bead's premise is unproven rather than false — the window may still bite later. |
| P5 | The carried 16,380,630 figure is **not reproducible** from any cutoff scope. Expect a value in the 10-20 MB raw range over a differing input count, i.e. the right order of magnitude and the wrong number — which is the shape a carried figure has. |

## What this spike will NOT settle

Whether ascend *needs* the log. That is a question about which questions handlers are asked, not
about bytes, and Q2 can only show whether the pressure the bead names is present today. If Q2 shows
no expiry and Q1 shows the cost is small, the honest output is a decision the owner can now make on
numbers rather than a recommendation dressed as one.

## Method

`cost.mjs` (Q1, Q4) and `append-race.mjs` (Q3) in this directory; both read-only against the corpus.
Findings, including every figure that came out against its prediction, in `FINDINGS.md`.
