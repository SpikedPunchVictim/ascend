# EV-2: does a bounded property vocabulary converge independently-authored type definitions?

**Question**    ARCHITECTURE.md controls type drift with a bounded property vocabulary
                (`string|number|integer|boolean|enum|timestamp|duration|ref|text`) and a small set of
                spec fields (`name`, `type`, `required`, `enum_values`, `description`, `unit`), on the
                assumption that constraining the *types* makes independently-authored definitions of
                the same concept converge. Does it?

**Method**      Five independently-authored `review-completed` type definitions
                (`spike/drift/spec-1.json` … `spec-5.json`), each produced from an identical brief,
                in a fresh context, with no sight of the others. One type name, one brief, one
                bounded vocabulary. Then measured: property-name set intersection/union, pairwise
                Jaccard, naming convention, `required` flags, and per-property type agreement.

**Measurement**

| metric | value |
|---|---|
| distinct property names across the 5 specs | **44** |
| property names shared by all five | **4** |
| intersection / union | **9.1 %** |
| mean pairwise Jaccard | **0.300** |
| min / max pairwise Jaccard | 0.167 / 0.400 |
| naming convention | **3 snake_case vs 2 camelCase** |
| sample 1 `required` flags | **all 14 properties marked required** |
| `reviewer` property type | `ref` in one spec, `string` in another |
| `outcome` enum | union 9 values / intersection **2** |
| `reviewerkind` enum | union 8 / intersection **1** |

Five agents, one brief, one type name, one vocabulary — and the result is **44 property names of which
only 4 are shared**. An LLM querying this registry would find that `review-completed` entries are
spread across four mutually incompatible shapes, with the *same concept* named four ways.

The failures are not exotic. They are the four that matter most at query time:

1. **Name drift** — 9.1 % agreement on property names at all.
2. **Convention split** — snake_case vs camelCase, so `review_kind` and `reviewKind` coexist as
   different properties.
3. **`required` collapse** — one author marked every property required. Under the three-state rule
   (`required` = "must have a *decision*", value or explicit N/A), this forces an N/A decision on 14
   properties per entry and makes the type unusable in practice.
4. **Enum divergence** — `outcome` has 9 values across specs but only 2 in common. Two specs can
   both say "outcome" and mean incompatible things.

## Decision

**GO-WITH-CHANGES — the bounded vocabulary is necessary but NOT sufficient.**

The bounded vocabulary alone does not produce convergence, so ARCHITECTURE.md's drift-control
mechanism as written is **inadequate** and must be strengthened. Define-time canonicalization is
required, specifically:

- **Name normalization** (case/separator folding) applied before a spec is accepted, so
  `review_kind` and `reviewKind` cannot both exist.
- **A shared property vocabulary** — a registry-level list of canonical property names with their
  canonical types, which a new type definition is matched against before registration.
- **Enum canonicalization**, so `outcome` values are drawn from a registry-level set rather than
  invented per registration.
- **A `required` sanity rule** — a definition marking every property required is almost certainly
  wrong and should warn at define time.

Threshold that decided it: intersection/union ≥ 0.70 would have confirmed the vocabulary as
sufficient (measured 0.091). A mean pairwise Jaccard ≥ 0.6 would have indicated convergence
(measured 0.300).

## Confidence

What this does **not** establish:

- **The canonicalization mechanisms are not themselves tested.** This measurement proves convergence
  *fails* without them; it does not prove that the four proposed remedies fix it. Each remedy needs
  its own measurement at E2, ideally by re-running this same five-author experiment *with*
  canonicalization active and confirming the intersection/union rises.
- **"Independent contexts" is not "independent authors."** All five specs came from the same model
  family. Drift between *different* models or between a model and a human is unmeasured, and would
  plausibly be worse.
- **One brief, one type.** A type with an obvious canonical shape (`review-completed` is abstract)
  may drift more than a mechanical one. Drift across briefs and type kinds is not measured.
- **No downstream cost was measured.** The claim that 9.1 % agreement makes queries fail is an
  inference from the shapes, not a measured query-failure rate. The real cost lands in E7 and E11
  and should be re-measured there.
- **The brief itself was not varied.** A more prescriptive brief would likely improve convergence
  and might make canonicalization unnecessary — untested, and the cheaper fix if true.
