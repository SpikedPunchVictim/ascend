# The five handlers, in English (the Q5 prompt)

Write each handler below. Output each one as a fenced code block whose first line is a comment
naming it (`# bead-close` in YAML, `-- bead-close` in SQL).

1. **bead-close**: when a shell command `bd close ...` succeeds (its second argv element is
   `close`), emit one row per bead id among its arguments from the third argv element on. A bead id
   matches `^[a-z]+-[a-z0-9]+(\.[0-9]+)*$`. Fields: `stage` = the id, `to_status` = `complete`.
2. **bead-claim**: when a shell command `bd update ...` succeeds and claims the bead, emit one row
   per bead id (same rule as above). It claims the bead when its arguments include `--claim`, or
   include an argument matching `^--status[= ]?in_progress$`, or include `--status` immediately
   followed by `in_progress`. Fields: `stage` = the id, `to_status` = `in_progress`.
3. **plan-status-edit**: when a file edit changes a file whose path ends in `PLAN.md`
   (case-insensitive), and the new text contains a status marker matching
   `\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)` (case-insensitive), and the old text
   has no such marker or has a different status word (compared exactly as written), emit
   `stage` = the file's last path segment, `from_status` = the old status word lowercased with
   whitespace replaced by `_` (omitted when the old text had none), and `to_status` = the new one
   in the same form.
4. **search-miss**: when a search returns 0 hits, and within the following 5 tool calls a search
   returns more than 0 hits with a pattern that shares a token with the empty search's pattern,
   emit `pattern` = the empty search's pattern, `returned` = `0`, `corrected_by` = the pattern of
   the FIRST such later search, and `search_tool` = the empty search's `via`.
5. **repeat-failure**: when a shell command fails, count the `command.run` events within the
   following 10 tool calls that belong to a LATER tool call than the failure, have the same `head`,
   and also failed. If there is at least one, emit `command` = the head and `failed_again` = the count.
