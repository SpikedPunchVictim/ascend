# EV-12: do the four sampling modes do what each one claims, on the real corpus?

**Question**    `asc explore --sample` offers four modes — `random`, `stratified`, `diverse`,
                `outlier`. Each is a claim about a subset: `random` that it is unbiased, `stratified`
                that it preserves the population's proportions *and* shows every value that occurs,
                `diverse` that it covers the most of the value space, `outlier` that it finds the tail.
                Do those claims hold on the real corpus at the real default sample size?

**Method**      The frozen EV-11 store (`/tmp/sx7/corpus/.ascend/ascend.db`, 1,491 entries of which
                486 are `verification_run`), driven through the real `asc` binary — not the pure
                functions, so the flag parser, the projection and the report are all in the path.
                Two properties, chosen because they fail differently:

                - `verdict` — 419 `passed`, 67 `failed`. Two strata, so the floor is never paid and
                  the rounding rule can be seen on its own.
                - `project` — ten values over 258 / 115 / 65 / 15 / 13 / 9 / 4 / 4 / 2 / 1. The values
                  themselves are the user's private repository names, so they are referred to by size
                  here. Four of them have an exact quota at a sample of forty below one row, so the
                  floor is paid four times and its cost is visible.

                Each mode at `--limit 40` in a single draw, then the two draw-based modes over
                **200 draws** at varying seeds, against a frozen input so the two arms cannot be
                confounded by the corpus growing between them. The bead's own accept criterion
                (*"stratified preserves enum proportions within tolerance"*) is what the deviation
                column measures; the tolerance is taken from the measurement rather than chosen.

**Measurement**

One draw at `--limit 40`, by `project` — how many of the ten values are absent from the sample:

| mode | rows | strata | strata unsampled |
|---|---|---|---|
| `random` | 40 | 10 | **6** |
| `stratified` | 40 | 10 | **0** |
| `diverse` | **29** | 10 | **0** |
| `outlier` | 40 | 10 | **1** (the 53 % majority) |

200 draws at `--limit 40`, `--by project`:

| arm | draws missing ≥1 value | unsampled strata per draw (min / mean / max) | the singleton value (1 of 486) absent in |
|---|---|---|---|
| `random` | **200 / 200 (100 %)** | 1 / **4.18** / 7 | **185 / 200 (92.5 %)** |
| `stratified` | **0 / 200 (0 %)** | 0 / 0 / 0 | **0 / 200 (0 %)** |

Deviation from each stratum's population share over those 200 draws:

| property | strata | floor paid | max deviation | mean deviation |
|---|---|---|---|---|
| `verdict` | 2 | no | **1.21 pp** | 1.214 pp |
| `project` | 10 | 4 rows | **10.59 pp** | 2.270 pp |

The floor's cost, from one allocation by `project` at 40 — the majority pays for every value that
would otherwise be absent:

| value | population | exact quota | allocated | delta |
|---|---|---|---|---|
| largest (258) | 258 | 21.23 | **17** | **−4.23** |
| second (115) | 115 | 9.47 | 10 | +0.53 |
| singleton (1) | 1 | 0.08 | 1 | +0.92 |

`diverse` returned **29 rows for a request of 40**, and the reason was measured rather than assumed:
`verification_run` has 60 distinct `(property, value-or-state)` pairs across its five categorical
properties, and those 29 rows cover **all 60 of them**. Once every pair is covered, no remaining item
can add one, so the mode stops rather than padding to the requested size. The coverage line reports
`shown 29 of 486` — 6 %. (Note this is *not* "one row per distinct signature": there are 128 distinct
signatures, and 29 items are enough because each carries five pairs.)

Determinism, by driving the binary twice: `random` reproducible **yes**, `--seed other` varies the
draw **yes**, `diverse` reproducible **yes**, `outlier` reproducible **yes**.

`outlier --by verdict --limit 5` selected **3 of the 67 `failed` against 2 of the 419 `passed`** — the
minority value at 60 % of the sample against 13.8 % of the population, a little over four times its
rate, since a `failed` entry is worth 1.98 nats on that key against a `passed` entry's 0.15. It is
**not** a pure filter, and the honest statement is that it
over-samples the tail rather than excluding the majority: the score sums over *every* categorical
property, so a `passed` entry carrying rare values elsewhere still ranks highly. A run against an
earlier fixture suggested 0 `passed` of 5; the real corpus does not reproduce that, and the fixture
figure is recorded here as the thing this measurement overturned.

## Decision

**GO — all four modes ship.** The claims are separately measurably true:

- **`random` is the control arm, and it is a bad one on a skewed corpus.** It missed at least one
  value in *every one* of 200 draws and left the singleton project out 92.5 % of the time. That is
  the finding the other three modes exist for, and it is now a number rather than an intuition.
- **`stratified`'s guarantee is absolute where it was measured.** Zero of 200 draws omitted any
  value, against 100 % of the random arm's doing so.
- **`diverse` and `outlier` are complements, not synonyms.** `diverse` returned 29 of 40 — the
  maximum coverage of the value space — and `outlier` returned 40 and left the majority behind.
  Neither is reproducible-but-arbitrary: both are functions of the population alone, so two runs
  agree without a seed.

**The bead's accept criterion is met, with a caveat that is part of the result.** *"Stratified
preserves enum proportions within tolerance"* holds at **1.21 pp** for a two-valued property — a
tolerance nobody had to choose, because the distortion is bounded by the rounding rule. It does
**not** hold at that figure once the floor is paid: ten strata at forty rows cost the majority
**4.23 rows** and put the worst stratum **10.59 pp** from its share. Both requirements in
ARCHITECTURE.md are satisfied (proportionality *and* "rare categories are guaranteed to appear"), but
they cannot both hold exactly, and the report discloses which one was traded — the achieved count
appears beside every stratum's population in the output, so a reader estimating from a stratified
sample can see the weight they are estimating with.

**Limitations, stated plainly.**

- These are *selection* measurements. Whether a stratified sample produces a **better answer** than a
  random one of the same size is a different question and is **not measured here** — that is
  `asc-asq`, which hand-labels ground truth and classifies from both arms. If stratified shows no
  advantage there, the mode is to be dropped rather than carried. **Unproven.**
- Validated on one corpus, one user, one machine. `n = 1` by the standard this project holds itself
  to, and a second foreign corpus has not been run.
- The deviation figures are for `--limit 40` on these two properties. The floor's cost scales with
  the number of rare strata, so a type with thirty values sampled at forty rows will distort more;
  that shape was not measured.
- `seedOf` is 32-bit FNV-1a, so two seed strings can collide and agree on a sample. Recorded as a
  limitation in the source rather than fixed: reproducibility is the requirement, collision
  resistance is not.

**Confidence**  High for the selection properties (driven end-to-end through the real binary against
                the frozen corpus, 200 draws per arm, counterfactual arm measured alongside).
                Low-to-none for the downstream claim that a stratified sample improves an LLM's
                answer — untested here, and the reason `asc-asq` is open rather than closed.
