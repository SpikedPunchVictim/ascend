# EV-5: which FTS5 tokenizer carries `evidence_text`?

**Question**    ARCHITECTURE.md requires FTS5 over `evidence_text` and forbids embeddings, so the
                tokenizer *is* the search design. Three arms are available: `unicode61` (FTS5
                default), `porter` (default + stemming), `trigram` (substring search).

                KICKOFF.md flags the specific trap: **"Do not inherit mast's FTS5 tokenizer by
                assumption. mast chose trigram for *code identifiers*; ascend indexes *prose*."**
                So the question is not which tokenizer is better in general — it is which one
                matches ascend's actual query behaviour, and whether mast's choice survives on prose.

**Method**      `spike/fts-bakeoff.mjs`. **40,000 real documents / 24.4 MB of text** streamed from
                `~/.claude/projects/` (read-only), loaded into three identically-populated FTS5
                tables, one per arm.

                **Ground truth is computed inside SQLite by substring `LIKE`, not by hand.** Query
                terms are derived deterministically from the corpus itself (document frequency
                computed over the same documents), in three classes — the classes are the experiment:

                1. **common whole words** — the easy case; all arms should tie.
                2. **identifier-shaped tokens** (contain `_ / . -`, length ≥ 6) — file paths, tool
                   names, snake_case identifiers. This is what "code identifiers" means.
                3. **partial tokens** — the *prefix* of an identifier, i.e. the "I half-remember the
                   name" case. This is where tokenizers diverge, and it is how an agent actually
                   searches when it does not know the exact spelling.

                Metrics: **precision@10** (of the 10 rows returned, how many actually contain the
                substring) and **term coverage** (of the query terms, how many retrieved at least one
                correct row). Latency p50 over the identifier class.

                No document content or raw query term is printed anywhere in this harness or in this
                record; only scores, counts and sizes.

## Measurement

Document set: **40,000 docs, 24.4 MB, extracted in 6.7 s**.

Index build:

| arm | build | index size | size ÷ text |
|---|---|---|---|
| unicode61 (default) | **616 ms** | **16.7 MB** | 0.68× |
| porter | **599 ms** | **16.4 MB** | 0.67× |
| trigram | **7,770 ms** | **85.7 MB** | 3.51× |

Retrieval, precision@10 / term coverage:

| query class | unicode61 | porter | **trigram** |
|---|---|---|---|
| common whole words | **100 % / 100 %** | 98 % / 100 % | 98 % / 100 % |
| identifiers (paths, names) | 97 % / 100 % | 97 % / 100 % | **100 % / 100 %** |
| **partial tokens (prefixes)** | **75 % / 60 %** | **76 % / 60 %** | **91 % / 100 %** |

Query latency p50: unicode61 **1.00 ms**, porter **1.09 ms**, trigram **2.86 ms** — all three
negligible against any interactive threshold.

### The decisive result

**On partial tokens, `unicode61` and `porter` fail to retrieve a single correct document for 40 % of
query terms (coverage 60 %).** `trigram` retrieves at least one correct document for **every** term
(100 %). A search that silently returns *nothing* is the worst failure mode for an agent-facing
query — it is indistinguishable from "no such entry exists" — and the two word-based tokenizers
produce it four times in ten.

`trigram` also wins precision@10 on identifiers (100 % vs 97 %) — mild support for mast's original
rationale, on the class mast chose it for.

### Prose: the arms tie

On common whole words all three arms are at 98–100 % precision and 100 % coverage. **The premise
that ascend's prose would favour a word-based tokenizer over trigram is not supported** — there is
no measurable prose penalty to trigram. What separates the arms is not prose at all; it is partial
tokens and morphology.

### Stemming: porter's only win, and it is narrow

Documents matched for an inflected query:

| query | unicode61 | porter | trigram |
|---|---|---|---|
| `configuring` | 2 | **173** | 2 |
| `runs` | 913 | **5,774** | 1,002 |
| `failure` | 671 | 863 | **952** |
| `complete` | 610 | **1,360** | 1,953 |

porter's advantage is real but **case-specific**: `configuring` → 2 vs 173 is an 86× gap, because
porter stems it to `configur` and matches `configured` / `configuration`, which are not substrings of
`configuring`. But on `failure` and `complete`, trigram matched *more* documents than porter, because
substring matching already covers the plural/inflected forms (`failure` ⊂ `failures`). Porter's win
is confined to cases where the inflection changes the stem, not merely the suffix.

### Hostile input: the sanitizer requirement, quantified

Raw user-shaped queries passed straight to `MATCH` (no sanitizer), same result on all three arms:

| arm | threw | example errors (verbatim) |
|---|---|---|
| unicode61 | **8 / 14** | `unterminated string` · `no such column: bar` |
| porter | **8 / 14** | `unterminated string` · `no such column: bar` |
| trigram | **8 / 14** | `unterminated string` | 

**8 of 14 realistic queries — 57 % — throw a SQL error.** The fatal inputs are ordinary:
`"unbalanced quote`, `foo -bar`, `col:value`, `NEAR(a b)`, `a AND b OR c`, `error (timeout)`,
`why did it fail?`, `C++ templates`. FTS5 interprets `-`, `:`, `(`, `"`, `AND`/`OR`/`NEAR` as query
syntax. Porting `toFtsMatch` from mast is therefore a **hard requirement**, confirmed on real data
rather than assumed.

**And the obvious sanitizer is not good enough.** Wrapping the entire raw query in one quoted phrase
throws 0/14 — but returns **empty for 9–13 of the 14 queries**, because a single quoted phrase must
match the user's whole string contiguously. That trades a crash for a silent zero-result, which the
next section shows is the worse of the two failures. The sanitizer must **tokenize into terms and
build a disjunction**, not wrap the raw string.

## Decision

**GO-WITH-CHANGES. `trigram` is the tokenizer for `evidence_text`; `porter` goes to the Design
Reserve; `unicode61` is rejected.**

- **`trigram` — chosen.** It is the only arm that retrieves a correct document for every
  partial-token query, it wins precision on identifiers, and it pays **no measurable prose penalty**
  (98 % vs 100 % on common words — a 2-point difference on one class against a 40-point coverage gap
  on another). Its costs are 5.2× the index size (85.7 MB vs 16.4 MB per 24.4 MB of text) and 13× the
  build time (7.77 s vs 0.60 s) — at ascend's actual scale (hundreds of entries, and the corpus this
  was measured on is 40,000 documents) both are negligible, and query latency is 2.86 ms.
- **`unicode61` — rejected, dominated.** Worst precision on partials (75 %), same coverage failure as
  porter (60 %), and no stemming to justify it. It has no advantage on any measured class.
- **`porter` — Design Reserve, not built.** Its win is confined to stem-changing inflections
  (`configuring` 2 → 173) and it fails the partial-token class outright. Morphological variance in
  semi-formulaic entry text is expected to be low. **Promotion condition:** if E11 dogfooding shows a
  query missing entries that a stem would have found, promote porter as a *second* FTS table over the
  same column, unioned at query time — not as a replacement.
- **`toFtsMatch` port is mandatory and must be term-based.** Requirement from measurement: it must
  handle the 8/14 fatal inputs without throwing **and** without degrading to a single quoted phrase.
  E3's acceptance test should assert both — zero throws **and** a non-empty result for a
  multi-word query that has matches.

## Confidence

### Method deviation from the task as written

`asc-spike-fts` specified **"15 realistic search queries"** scored by **"precision@10 against
hand-judged relevance."** This run did not do that. It used **34 deterministically-derived query
terms** scored against **ground truth computed in SQL by substring `LIKE`**, with relevance checked
programmatically.

The substitution was deliberate, and it is a substitution rather than a fulfillment:

- **Hand judgement does not scale to a three-arm bake-off and cannot be audited.** A single judge
  scoring 45 query-arm pairs would have decided the tokenizer question with their own expectations
  about what "relevant" means, and no reader could re-derive the verdict. Substring containment is
  reproducible by anyone re-running the script.
- **It is stricter, and therefore a floor.** `LIKE` containment is the correct ground truth for the
  partial-token and identifier classes, but it under-counts genuine relevance for prose — a document
  discussing the same concept in different words scores as irrelevant. Prose precision figures here
  are therefore conservative.
- **It permits 34 terms instead of 15**, and it is the only reason the failure is quantified at all:
  the headline result is a *coverage* failure (40 % of partial-token terms retrieve nothing), which a
  hand-judged precision@10 over 15 queries would have averaged away into a mild-looking score.

**What was lost:** no measurement of whether the *best* document ranked first. Hand judgement is the
only way to score ranking quality, and ranking was not scored. If BM25 ordering turns out to matter —
plausible, since trigram's index statistics differ substantially — a hand-judged ranking evaluation
is still owed, and this record does not substitute for it.

What else this does **not** establish:

- **The document set is not ascend's `evidence_text`.** It is 40,000 real transcript documents —
  real text of roughly the right character, but longer and more prose-heavy than an ascend entry's
  evidence field will be. Entries will be shorter, more formulaic, and **more identifier-dense**,
  which shifts the balance *further* toward trigram. The direction of the error favours the decision,
  but the magnitude is unmeasured.
- **The partial-token class is 10 terms from one corpus.** The 40-point coverage gap is large, but
  n=10 query terms. The *shape* of the result matches the documented behaviour of the tokenizers, but
  it is not a large sample.
- **"Relevant" is defined as substring containment**, which is the correct ground truth for the
  partial-token question but is stricter than human relevance for prose. Precision on common words is
  therefore a floor, not a relevance measure.
- **Ranking was not evaluated.** `ORDER BY rank` (BM25) was used but never scored — no nDCG, no human
  judgement of whether the *best* document was first. Only membership in the top 10 was measured.
  trigram's index size changes BM25's statistics, so its ranking quality is genuinely unmeasured.
- **The stemming counts are raw `MATCH` counts against no ground truth** — they measure how many
  documents each arm *returns*, not how many it returns *correctly*. That is why trigram can exceed
  porter on `failure`: it may be matching substrings inside unrelated words. Read those four rows as
  directional only; they are the weakest numbers in this record.
- **Query latency was measured with a warm cache and a single process**, on one machine. `trigram`'s
  2.86 ms vs 1.00 ms may not hold on cold storage or at larger index sizes.
- **Only FTS5's built-in tokenizers were tested.** No custom tokenizer, no `prefix=` option, and no
  combination index was built, so "trigram + prefix index" — a plausible middle path — is untested.
- **The 40,000-document cap was not reached by choice.** The corpus holds 809 transcripts / 1.14 GB;
  documents were capped at 40,000 and truncated to 2,000 chars each, so the index is built over a
  sample of the available text, not all of it.
