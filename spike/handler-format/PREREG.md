# Spike asc-6ola.5 — handler format: pre-registration

Written 2026-09-23 before any handler was ported. Sealed by sha256 in the bead's notes.

**Input, frozen:** the same APFS clone of `~/.claude/projects` that `spike/replay` used (taken
2026-09-23T06:46:47Z), scoped to this project's 77 transcript files (96,631 events in that spike).

**Reference:** the four JS handlers in `spike/replay/replay.mjs`, run over the same event stream.
Parity means the same set of emitted `(file, seq, fields)` rows, compared as sorted JSON.

**Candidates:**

- **A — strict YAML 1.2**: one document per handler. `on` (event kind), `where` (field
  predicates), `capture` (named regex groups), `each` (fan out over an array), `window` (following
  events, keyed by transcript file, bounded by tool calls, with `first` / `count`), `emit` (a
  field map with `${name}` substitution and a fixed filter set). A loader refuses anchors,
  aliases, merge keys, and tags, and hashes the canonical parsed form.
- **B — SQL over an event table**: `node:sqlite` (what the store uses), one row per event, one
  `SELECT` per handler, and user functions registered for whatever SQLite lacks.

**Window rule used by both candidates.** Each event carries `call`, the index of the tool call it
belongs to within its file. "Within 5 calls" means events after the trigger (by `seq`) whose
`call` is at most `trigger.call + 5`. The reference counts `tool.use.end` events instead, and so
it stops before the 5th call's own `search.run`. Any parity gap this causes is attributed to that
rule and counted, not hidden.

## Questions

- **Q1** Can each candidate express the four spike handlers with match-set parity to the JS reference?
- **Q2** What does each candidate need beyond a generic core, i.e. bespoke primitives (A) or
  user functions (B)?
- **Q3** Does each candidate express a fifth handler that neither was designed around: a command
  that fails, followed by the same command head failing again within 10 calls (a count window)?
- **Q4** What does evaluation cost over the scoped corpus: normalization, then per candidate?
- **Q5** Can a model write correct handlers unaided, from a spec and an English description, in
  each candidate?
- **Q6** Does the strict loader refuse what it must, and does the canonical hash ignore formatting?

## Predictions

| # | prediction |
|---|---|
| P1 | A reaches parity on **4 of 4** reference handlers, apart from the window-rule gap. |
| P2 | B reaches parity on **4 of 4**, apart from the same gap. |
| P3 | A needs exactly **1** bespoke primitive beyond the generic core: token overlap for `search_miss`. B needs **≥ 3** user functions (regex test, regex capture, token overlap). |
| P4 | Both express the fifth handler with **no new** primitive or function. |
| P5 | A evaluates the four handlers in **< 1 s**. B (load the table, then run the four queries) takes **< 5 s**, and is slower than A. |
| P6 | A model (sonnet) writes **≥ 3 of 5** handlers with parity in each candidate, and the count for B is **≥** the count for A, because models know SQL and meet this YAML for the first time. n = 5 per candidate is an anecdote. |
| P7 | The loader refuses **4 of 4** hazard inputs (anchor+alias, merge key, explicit tag, and a number where a string is required, e.g. `head: 1.10`). Two formattings of one handler hash equal; changing one value changes the hash. |
