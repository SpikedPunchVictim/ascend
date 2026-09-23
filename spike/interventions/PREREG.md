# asc-6ola.1 — do real lessons fit an "intervention" shape? Pre-registration

Written 2026-09-23 before classifying. Sealed by sha256 in the bead notes.

**Data.** The 33 `bd remember` memories in this repo (`bd memories --json`, the `schema_version`
key excluded). They are the project's lessons as written by hand. n = 33 clears MIN_N (20), but it
is one rater (me) over one project.

**Scheme**, applied per memory:

- `kind`: `lesson` (says how to act differently next time) · `fact` (reference knowledge with no
  "act differently") · `record` (status, progress, or a decision log; not a lesson).
- `class`: the failure class a lesson belongs to, as a free label assigned first, merged after.
- `trigger`: for a lesson, can the moment it applies be detected by a handler over events?
  `event` (a one-event predicate on `file.changed` / `command.run` / tool input) · `window`
  (needs a sequence) · `none` (no detectable moment: it applies to reasoning).
- `check`: does an executable check already enforce it? `exists` (a named test or guard,
  **verified to exist on disk**) · `possible` (could be one, none exists) · `no` (it can't be a
  check).

## Predictions

| # | prediction |
|---|---|
| I1 | ≥ 25% of the 33 are not lessons (`record` or `fact`). They would not become interventions. |
| I2 | Of the lessons, ≥ 50% have `trigger = event`. |
| I3 | Of the lessons, ≥ 30% have `check = exists`: already mechanized, so the intervention already exists and was never linked. |
| I4 | At least one class holds ≥ 5 lessons (expected: false green). |
| I5 | ≥ 20% of lessons need more than one intervention (guidance *and* a check), so intervention-to-lesson is many-to-one. |
| I6 | ≥ 25% of lessons have `trigger = none`. That is the part only a reviewer or a checklist can reach. |
