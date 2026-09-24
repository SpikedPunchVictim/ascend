# Candidate A: handlers in strict YAML 1.2

A handler is one YAML document. It reads the normalized event stream of one transcript file, in
order, and emits zero or more rows per event it matches.

## Events

Each event has `kind`, `seq` (its position in the file, from 0), and `call` (the index of the tool
call it belongs to, from 1, in the order the calls started). All events of one tool call share its
`call`. Fields by kind:

| kind | fields |
|---|---|
| `prompt.submit` | `text` |
| `tool.use.start` | `tool`, `id` |
| `tool.use.end` | `tool`, `id`, `ok` (bool) |
| `command.run` | one per shell command segment of a Bash call: `head` (the program, e.g. `bd`), `argv` (array of strings; `argv.0` is the head), `ok` (bool: the whole Bash call's success) |
| `search.run` | `via` (`grep`, `rg`, `find`, `Grep`, `Glob`, ...), `pattern` (string), `hits` (integer: results returned) |
| `file.changed` | `path`, `before` (text replaced), `after` (text written) |

`tool.use.end` comes first, then the call's `command.run`, `search.run`, and `file.changed` events.

## Keys

```yaml
on: command.run            # required: the event kind that triggers the handler
capture:                   # optional: named regex groups, taken from the trigger event
  to: { field: after, regex: 'Status: (\w+)', group: 1, flags: i }
where:                     # optional: every entry must hold (AND)
  ok: true
  head: bd
  argv.1: close            # dotted index into an array
each:                      # optional: emit once per matching element of an array
  field: argv
  from: 2                  # start index, default 0
  matches: '^[a-z]+-\d+$'
  as: id                   # name bound for emit
window:                    # optional: look at the events that follow the trigger
  calls: 5                 # later events whose call is in [trigger.call, trigger.call + 5]
  first:                   # binds window.first: the first following event that matches
    on: search.run
    where: { hits: { gt: 0 } }
  # or
  count:                   # binds window.count: how many following events match
    on: command.run
    where: { ok: false }
  at_least: 1              # with count: emit only if window.count >= at_least (default 1)
emit:                      # required: the row, a map of output field -> template
  stage: '${id}'
  to_status: complete
```

With `window.first`, the handler emits only if some following event matches.

### Matchers in `where`

A `where` key is a field name (a dotted path such as `argv.1`) or a capture reference such as
`$to`. The value is either a literal, which means equality, or a map with exactly one operator:

| operator | meaning |
|---|---|
| `eq`, `ne`, `gt`, `gte`, `lt`, `lte` | comparison |
| `in: [a, b]` | equals one of |
| `matches: 're'` | string matches the regex (JS syntax). Add `flags: i` beside it for case-insensitive matching |
| `contains: x` | array has an element equal to `x` |
| `any_matches: 're'` | array has an element matching the regex |
| `followed_by: [a, b]` | array has `a` immediately followed by `b` |
| `exists: true/false` | field or capture is present or absent |
| `shares_token: $field` | the two strings share a token. A token is a run of `[a-z0-9_]` after lowercasing, at least 4 long, not in {src, dist, test, users, projects, head, type, json, jsonl} |

Combinators may appear as keys: `any: [ {where}, ... ]` (OR), `all: [ ... ]`, and `not: {where}`.

A comparison value written as `$name` refers to a capture, or to a field of the TRIGGER event.
Inside `window.first.where` / `window.count.where`, plain keys are fields of the following event
and `$name` values are fields of the trigger. An absent field compares as absent: `ne` is true and
every other operator is false.

### Templates in `emit`

A value is a literal string, or contains `${name}` or `${name|filter}`. `name` is a field of the
trigger, a capture, an `each` variable, `window.first.<field>`, or `window.count`. The filters
are `basename` (last path segment) and `snake` (lowercase, whitespace to `_`). If a template is
exactly one `${...}` whose value is absent, the output field is omitted.

## Strictness

The loader refuses anchors, aliases, merge keys (`<<`), and explicit tags. It refuses a literal
whose type does not fit its field: `head: 1.10` is a number and `head` is a string, so it is
refused. Quote such values: `head: '1.10'`. Unknown keys are refused. Regexes are compiled once
at load time. The handler's identity is the sha256 of its parsed form, so formatting and comments
do not change it.
