#!/bin/sh
# Written by `asc install-hook`. Regenerated in full every time that command runs, so a hand
# edit here does not survive the next install or upgrade -- see hook-script.ts's `hookScript`.
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

# Put a bare `asc` on this session's PATH, for the shell Claude Code hands to the tools in it.
#
# ABOVE the resolution below, and the order is load-bearing rather than tidy: the resolution ends in
# `exit 0` when it finds no binary, and the ordinary outside-the-project install -- where the shim
# is the ONLY thing that will ever put `asc` on PATH -- is precisely the case that reaches that
# exit. With this block below it, the hook would exit before writing the entry that makes the shim
# reachable, and `install-hook` would report success while no session ever saw a bare `asc`.
# Measured: the export produced nothing until this block moved (the scratch project's own hook run
# exited 0 at the resolution and never reached the write).
ascend_bin_dir="$root/.ascend/bin"
if [ -n "$CLAUDE_ENV_FILE" ] && [ -x "$ascend_bin_dir/asc" ]; then
  printf 'case ":$PATH:" in\n  *":%s:"*) ;;\n  *) export PATH="%s:$PATH" ;;\nesac\n' \
    "$ascend_bin_dir" "$ascend_bin_dir" >> "$CLAUDE_ENV_FILE"
fi

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
elif [ -x "$root/.ascend/bin/asc" ]; then
  bin="$root/.ascend/bin/asc"
elif command -v asc >/dev/null 2>&1; then
  bin="$(command -v asc)"
else
  exit 0
fi

case "$bin" in
  *.js)
    command -v node >/dev/null 2>&1 || {
      echo "asc: $bin needs node, and node is not on PATH" >&2
      exit 1
    }
    run() { node "$bin" "$@"; }
    ;;
  *)
    run() { "$bin" "$@"; }
    ;;
esac

# With a stage (`sh ascend-hook.sh post-tool-use`), this is a lifecycle hook for the project's
# say: handlers: the hook's JSON input is on stdin, and `asc hook` reads it from there.
#
# EVERY argument is forwarded, not just the stage, because a stage's entry may carry flags -- the
# holdout rate `asc install-hook --holdout` bakes in (asc-xn4g). Forwarding `"$1"` alone dropped
# them silently: the entry would read `... post-tool-use --holdout 0.3`, the flag would never
# reach `asc hook`, and the project would run no experiment while its settings.json said it did.
if [ -n "$1" ]; then
  run hook "$@"
  status=$?
  [ "$status" -eq 0 ] || exit 1
  exit 0
fi

run ingest claude-code >/dev/null 2>&1

# Capture reads and WRITES, and its stderr is the ONLY channel it has to the model: on
# SessionStart, exit-0 stderr is discarded and never reaches the transcript (the Claude Code
# hooks reference is explicit, and dogfood/0082 is three sessions of that silence). So its
# stdout is discarded -- a table on the injected stream would put ascend's own bookkeeping in
# front of a session as if it were context -- and its status is TESTED rather than swallowed.
# A watched file that is there and cannot be read writes no row and no baseline, and says so;
# exiting 0 there would make a capture that has silently stopped capturing look like one that
# found nothing.
run capture >/dev/null
capture_status=$?

# Last, and still unconditioned on everything above: a broken ingest or an unreadable watched
# file must never suppress the one thing this hook has always reliably done.
run types brief
brief_status=$?

[ "$capture_status" -eq 0 ] || exit "$capture_status"
exit "$brief_status"
