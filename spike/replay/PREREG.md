# Spike asc-bolz — replay handlers: pre-registration

Written 2026-09-23 before any handler ran. Sealed by sha256 in the bead's notes.

**Input, frozen:** an APFS clone of `~/.claude/projects` taken 2026-09-23T06:46:47Z — 1,007 `.jsonl`
files, 1.9G. Nothing below reads the live directory (it is written by the session running this spike).

**Ground truth:** the hand-recorded entries in `.ascend/ascend.db` — 31 `stage_transition`, 5
`search_miss`. Hand entries are a lower bound on what happened, never the full set.

## Questions

- **Q1** Can `stage_transition` be produced by a matcher with no model involved?
- **Q2** How much of what happened did the hand path catch?
- **Q3** Can a structural matcher find `search_miss`, and is what it finds real?
- **Q4** Are the matchers expressible declaratively (one-event predicate + field mapping), or do they
  need code?
- **Q5** What does a full replay cost, and what would an ascend-owned normalized event log cost to keep?

## Predictions

| # | prediction |
|---|---|
| P1 | The bead-transition matcher (`bd close` → complete; `bd update --claim` / `--status in_progress` → in_progress) recovers **≥ 25 of 31** hand `stage_transition` entries (same bead id, event within ±60 min of `recorded_at`). |
| P2 | The matcher finds **≥ 3×** as many transitions as were hand-recorded over the same period (hand recall ≤ 33%). |
| P3 | Plan-document Status edits are the **minority** source: fewer than bead transitions. |
| P4 | The structural `search_miss` matcher (a search with zero hits, followed within 5 tool calls by a search sharing a term that has hits) recovers **≤ 1 of 5** hand entries — 4 of the 5 are misread non-empty results, which no structural rule sees. |
| P5 | Of 20 randomly sampled structural candidates, **≤ 50%** are real misses (a zero read as "does not exist"). One rater, labelled as such. |
| P6 | Full replay of the frozen corpus through both handlers takes **< 60 s** in one process. |
| P7 | `stage_transition` is a one-event predicate + mapping (declarative); `search_miss` needs a window/sequence operator. |
| P8 | The normalized event log (tool name, command head, outcome, hit count, ids, timestamps — no payload bodies) is **< 5%** of the transcript bytes it came from. |
