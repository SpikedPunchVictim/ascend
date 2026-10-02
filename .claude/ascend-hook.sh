#!/bin/sh
# Written by `asc install-hook`. Regenerated in full every time that command runs, so a hand
# edit here does not survive the next install or upgrade -- see install-hook.ts's `hookScript`.
#
# Resolves the project root and the ascend binary at RUN time, in THIS file, rather than in
# .claude/settings.json: that file is shared, tracked, team configuration, and a path measured on
# one checkout was only ever correct for that one checkout (asc-cjm, dogfood/0009).

root=${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)}

# .ascend/ is gitignored, so a teammate who clones this repository has the hook and no
# store -- exit 0 and print nothing, the same contract every guard in this file keeps.
[ -d "$root/.ascend" ] || exit 0

# Both commands below find their store by walking UP FROM THE WORKING DIRECTORY, never from
# `$root` -- so without this the guard above and the commands it guards are talking about two
# different projects. Measured: run from `/` with a valid `$root`, the guard passed and
# `types brief` still exited 1 with "No .ascend/ store found in /". That is the benign half.
# `ingest` WRITES, so the same mismatch in a directory that does have a store above it would
# file one project's transcripts into another project's database, silently and irreversibly.
cd "$root" || exit 0

# To record an entry by hand, run: asc record TYPE -  (a JSON entry on stdin)
# The resolution below is THIS script's own job -- how a hook finds a binary that is not on
# PATH -- and is not a form to copy: an allow rule matches the literal text of a command, so a
# path form is a different command to the one an allow-list entry names, and is refused.
if [ -n "$ASCEND_BIN" ] && [ -f "$ASCEND_BIN" ]; then
  bin="$ASCEND_BIN"
elif [ -f "$root/node_modules/.bin/asc" ]; then
  bin="$root/node_modules/.bin/asc"
elif [ -f "$root"'/packages/cli/dist/bin.js' ]; then
  bin="$root"'/packages/cli/dist/bin.js'
elif command -v asc >/dev/null 2>&1; then
  bin="$(command -v asc)"
else
  exit 0
fi

case "$bin" in
  *.js)
    command -v node >/dev/null 2>&1 || exit 0
    run() { node "$bin" "$@"; }
    ;;
  *)
    run() { "$bin" "$@"; }
    ;;
esac

# With a stage (`sh ascend-hook.sh post-tool-use`), this is a lifecycle hook for the project's
# say: handlers: the hook's JSON input is on stdin, and `asc hook` reads it from there.
if [ -n "$1" ]; then
  run hook "$1"
  exit 0
fi

run ingest claude-code >/dev/null 2>&1
run types brief
