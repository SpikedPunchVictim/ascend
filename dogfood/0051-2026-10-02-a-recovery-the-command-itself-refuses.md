# 0051 — a recovery ascend prints is a command ascend refuses

| | |
|---|---|
| **Bead** | `asc-i8cs` |
| **Surfaced** | 2026-10-02 |
| **Surfaced by** | the E12.14 adversarial review (three independent agents reading one diff), then reproduced by driving the real binary |
| **Entry type(s)** | `decision` (starter) |
| **Severity** | P3 — one failed command for a human; the session path never meets it |
| **Status** | fixed in the working tree |

## What was found

`asc record TYPE -` — the form E12.14's brief teaches in every session — validates the piped document
against the named type, and where a required property has no decision recorded it says so and offers
the caller a fix. The fix it offers is `--prop=<name>=<value>`. That flag **cannot be combined with
the document the caller is holding**: `record.ts` refuses a document and entry flags together, exit 2.

So the only recovery ascend names is refused by the command ascend named it from. The caller has a
message they can act on only by throwing away the input they came with, and nothing in the message
says that is what it costs. The `--na` half — *"Or record that it does not apply: `asc record <type>
--na <name>`"* — is the same defect: a real command in general, and equally refused beside a document.

**The defect is reachability, not shape.** Every fix string in the message correctly names the field
it is about. None of them was ever tested against the command line that would receive it.

## How it surfaced

**Nobody was looking for it.** The review was looking for arithmetic and cross-artifact disagreement
in the E12.14 diff, and the finding arrived by asking a narrower question than the one the fix
answered: *what does a caller who takes this message literally actually run?* The message was read,
not executed; executing it is what turned a plausible string into exit 2.

What made it visible is that the two halves of the message were written by the same code path that
does not know how the entry arrived. The document path and the flags path produce byte-identical
`EntryInput` at the store — so the wording was never at risk of being wrong *for the flags caller*,
only for the one the brief was steering everybody toward.

## The metric

The advertised form, with an empty document, on this repo's own `decision` type:

```
$ printf '{}' | asc record decision -
Error: 1 problem(s) with this decision entry, so nothing was recorded:
  chosen: 'chosen' is required and has no decision recorded
    Supply the value with --prop=chosen=<value>; ascend cannot invent one. Or record that it does
    not apply: asc record decision --na chosen
```

Applying the first half to the form it was reached from — and the second half separately, so neither
is assumed to behave like the other:

```
$ printf '{}' | asc record decision - --prop=chosen=walk-up
Error: a document (-) and entry flags (--prop/--na/--evidence) cannot be
combined: they describe the same entry twice. Use the document, or use flags.
--type-version, --run-id, --workflow, --actor and --dry-run apply to either.
exit=2

$ printf '{}' | asc record decision - --na chosen
Error: a document (-) and entry flags (--prop/--na/--evidence) cannot be
combined: they describe the same entry twice. Use the document, or use flags.
--type-version, --run-id, --workflow, --actor and --dry-run apply to either.
exit=2
```

**Both halves refused, exit 2, same message.** After the fix, the document path names the document:

```
$ printf '{}' | asc record decision -
Error: 2 problem(s) with this decision entry, so nothing was recorded:
  chosen: 'chosen' is required and has no decision recorded
    Required means a value OR an explicit N/A -- not necessarily a value. Give
    "chosen" a value in the document's properties, or list it in its "na" array
    if it does not apply.
  rationale: 'rationale' is required and has no decision recorded
    ...
```

and the flags path is unchanged (`Supply the value with --prop=chosen=<value>`, plus `--na chosen`),
which is the control: the change is a branch on how the entry arrived, not a replacement.

The completeness claim is asserted rather than spot-checked: `core/test/state.test.ts` sweeps *every*
error a document entry produces and requires that none matches `/--(prop|na|evidence)\b/`, with a
control arm proving the same sweep on the flags path does match.

## The pattern

**Advice is validated for shape and never for reachability.** The message named the right field, in
the right vocabulary, with a syntactically valid flag — and every one of those properties was checked
by whoever wrote it. What was never asked is whether the caller receiving the message can run it,
which depends on state the message-rendering code did not carry.

The class generalizes past this command: any error path that renders a fix from the *store's* view of
what is wrong is guessing about the *caller's* context, and it will be right for the common caller and
wrong for exactly the caller a new surface just created. The tell is a fix string that was written
before the surface that reads it.

## Why nothing else would have caught it

**A test did cover this string, and it covered it in the direction that hid the defect.**
`packages/cli/test/record.test.ts`'s *"does NOT print a runnable command whose value ascend had to
invent"* piped `{}` — the document path — and asserted that the message contains
`--prop=missing=<value>` **and** `asc record pair --na missing`. It was green, and it was green while
*requiring* the two spellings that cannot be run. Its own load-bearing assertion — that ascend never
prints a runnable `asc record … --prop=` line with a fabricated value — was correct and passed; the
two `toContain` assertions around it encoded the defect as a spec.

So this is not a coverage gap. It is a test that asserted a message's text where the property that
mattered was the message's usability, which no assertion about text can express. Fixing it meant
changing those two expectations to the document vocabulary and **moving the flag half onto a second,
flag-driven invocation of the same type**, so the original intent survives as a control rather than
being deleted.

A review of the string could have caught it — the review that found it did — but only by executing the
advice. Reading it is what made it look correct for three rounds.

## Consequences and constraints

**Nothing was recorded, so nothing needs invalidating.** Every path here refuses before the write.

**The store cannot make this decision.** At `RecordRequest`, an entry offered as a document is
byte-identical to one offered as flags; the shape carries no evidence of how it arrived. So the answer
travels with the request (`via`), read off the CLI's own argv, and **absent means flags** — spread
rather than defaulted — so no existing caller changes behaviour and none has to opt in to the old
wording. `validateEntry` is pure and stays pure; it renders a fix for the form it was told about.

## Links

- Bead: `asc-i8cs`
- Related: `dogfood/0052` — the other E12.14 review finding closed in the same pass, and the same
  class from the other side: a message that never arrives at all
- Entries recorded at the time: none — both commands refuse before writing
