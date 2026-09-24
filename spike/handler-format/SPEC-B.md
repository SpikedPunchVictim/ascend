# Candidate B: handlers as SQL over an event table

A handler is one SQLite `SELECT` (the `node:sqlite` build, JSON1 included). It runs over a table
holding the normalized event stream of every transcript file, and returns one row per emitted row.

## The table

```sql
CREATE TABLE events (
  file    TEXT,     -- the transcript file; windows never cross files
  seq     INTEGER,  -- position of the event in its file, from 0
  call    INTEGER,  -- index of the tool call the event belongs to, from 1, in the order calls started
  kind    TEXT,     -- prompt.submit | tool.use.start | tool.use.end | command.run | search.run | file.changed
  tool    TEXT,     -- tool name (Bash, Grep, Edit, ...)
  id      TEXT,     -- tool call id
  ok      INTEGER,  -- 1/0 on tool.use.end, command.run, search.run, file.changed; NULL otherwise
  head    TEXT,     -- command.run: the program, e.g. 'bd'
  argv    TEXT,     -- command.run: JSON array of strings; argv[0] is the head
  via     TEXT,     -- search.run: grep, rg, find, Grep, Glob, ...
  pattern TEXT,     -- search.run
  hits    INTEGER,  -- search.run: results returned
  path    TEXT,     -- file.changed
  before  TEXT,     -- file.changed: text replaced
  after   TEXT,     -- file.changed: text written
  text    TEXT,     -- prompt.submit
  ts      TEXT
);
-- indexes: (kind), (file, call)
```

All events of one tool call share its `call`. A Bash call yields one `command.run` per shell
command segment, and all of them carry the whole call's `ok`. Within a call, `tool.use.end`
comes first, then that call's `command.run`, `search.run`, and `file.changed` rows.

## Functions registered beside SQLite's own

| function | returns |
|---|---|
| `x REGEXP p` / `regexp(p, x)` | 1 if string `x` matches JS regex `p` |
| `regexp_i(p, x)` | the same, case-insensitive |
| `regex_capture(x, p, group, flags)` | the group's text, or NULL when there is no match (`flags` may be `''` or `'i'`) |
| `shares_token(a, b)` | 1 if the two strings share a token. A token is a run of `[a-z0-9_]` after lowercasing, at least 4 long, not in {src, dist, test, users, projects, head, type, json, jsonl} |
| `basename(p)` | last path segment |
| `snake(s)` | lowercase, whitespace to `_` |

## The contract

The query must return the columns `file` and `seq` (the TRIGGER event's), followed by the
emitted fields as named columns. A NULL column is omitted from the row. Every emitted value
is compared as a string. "Within N calls after an event `e`" means rows `f` with
`f.file = e.file AND f.seq > e.seq AND f.call BETWEEN e.call AND e.call + N`.
