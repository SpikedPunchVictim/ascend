---
description: Analyse one or more ascend entry types using the ascend-analysis method.
argument-hint: <type> [type...]
allowed-tools: [Bash, Read, Grep, Glob]
---

Analyse the entry type(s) named in `$ARGUMENTS`.

If `$ARGUMENTS` is empty, run `asc types list` and ask which type to analyse -- do not guess a
type to fill the gap.

Otherwise, follow the `ascend-analysis` skill's six-step method, in order, for each named type:
profile, sample, cluster, hand-label a sample, back-test a proposed rule, then commit the pass.

The one rule worth repeating at the call site: do not write an annotation pass that has not been
back-tested against a hand-labelled sample first.
