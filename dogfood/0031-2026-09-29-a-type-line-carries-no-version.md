# 0031 — a type line carries no version, so file order is the only thing that numbers it

| | |
|---|---|
| **Bead** | `asc-i5tj.6` |
| **Surfaced** | 2026-09-29 |
| **Surfaced by** | a forward-vs-reverse write of the same record set, read back and compared byte-for-byte |
| **Entry type(s)** | `decision` (`hand_empty`) — E12's read-ordering rule |
| **Severity** | P1 |
| **Status** | open |

## What was found

E12.1's ordering rule is deliberate and asymmetric: entry and annotation lines are sorted on read,
because their file order is an artifact of merging; type and scheme lines keep FILE order, because
registration order is what defines a version number. The stated hazard the rule exists to prevent is
that "reordering type lines would silently renumber versions".

**The rule does not prevent that hazard.** It preserves whatever order the merge produced, and
`merge=union` concatenates the two sides in a direction-dependent order. A `TypeLine` carries no
version of its own — `documentFromRow` (`packages/store/src/document.ts:79`) drops `version` and
`major` entirely, so the line is `{kind, name, properties, …}` and nothing else. Two branches that
each register a version of the same type therefore merge to two files with the same line SET and
different line ORDER, and since the version is read from the order, the same content is numbered
differently on the two clones.

## How it surfaced

By writing the same 10,263-line real corpus through the layer twice — once in export order, once
reversed — reading both back and comparing the serialized output. The check was written to confirm
that the ordering rule works, and it came back `false`; isolating by kind then showed where.

**Nobody was looking for it in the sense that matters.** The check was aimed at the entry sort. The
type/scheme half of the rule was the part everybody already agreed was correct — it is the reason
the layout is flat and append-only — and it is the part that does not hold. This is the class the
empirical-planning method names directly: the risk the plan's internal consistency makes feel
already-settled.

## The metric

```
$ node /tmp/rt3.mjs
entries+annotations  n=10239  forward===reverse: true
types+schemes        n=24     forward===reverse: false
```

10,239 entry and annotation lines round-trip byte-identically under either write order. The 24 type
and scheme lines do not. The whole-corpus check, before the isolation:

```
forward vs reverse write of the same set, read back byte-identical: false
lines out: 10263
```

A type line as exported, showing the absence of a version field:

```
$ grep -o '"kind":"type"[^}]*}' /tmp/real-export.jsonl | head -1
"kind":"type","name":"context_compaction","properties":[{"name":"cumulative_dropped_tokens","type":"integer","required":true}
```

## The pattern

**A guard that reproduces the thing it guards instead of securing it.** "Keep file order" is a rule
that says *do not reorder*, which is unenforceable against a merge that reorders before the reader
sees it. A rule that secured the hazard would have to make the version explicit on the line, so that
order stops being load-bearing — the same move the entry sort makes, one kind over. The class:
anywhere correctness depends on the ORDER of lines in a file that git is allowed to union-merge,
and the order is not also written down.

## Why nothing else would have caught it

Not by the tests written for E12.1, which asserted that type lines keep file order — a test that
CONFIRMS the rule rather than testing the hazard it claims to prevent. Not by `align check`. A
review could have caught it by following the reasoning "version comes from order; merges reorder;
therefore versions can change", but the rule's own statement in the bead supplies the first two
premises and then concludes the opposite, which is exactly what makes it hard to read past.

## Consequences and constraints

This is a FORMAT question, not a layer question, and it is filed rather than fixed: making the
version explicit changes the corpus every existing export produces, which is E12.4's migration
surface and not E12.1's. E12.1 implements the bead as written.

Note also that the scheme half of the rule is unaffected in practice — a scheme line DOES carry
`version` (`jsonl.ts:85-92`), so a reordered scheme file renumbers nothing. The asymmetry is the
finding: the two kinds are in one rule for the same stated reason, and the reason is only load-bearing
for one of them.

## Links

- Bead: `asc-i5tj.6`
- Parent: `asc-i5tj` (E12), stage `asc-i5tj.1`
- Related: `dogfood/0030` (a scheme name is any string), surfaced by the same round trip
- Plan text this contradicts: `IMPLEMENTATION_PLAN.md` E12.1, "registration order is what defines a
  type's version numbers"
