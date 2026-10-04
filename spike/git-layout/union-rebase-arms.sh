#!/usr/bin/env bash
# asc-3ow4 / P3: do `git rebase` and `git cherry-pick` honour `merge=union`?
#
# P3 of asc-3ow4's pre-registration predicted a CONFLICT for both, reasoning from gitattributes(5)
# -- "git itself does not use merge drivers during rebase/cherry-pick". It was never exercised:
# every server-side arm refused at the mergeability gate before any strategy ran, so P3 stayed
# "untested, not confirmed" through EV-31, EV-40 and EV-41. This arm exercises it, command-line
# git only: no forge, no credentials, no browser.
#
# The contrast this rests on is the fixture's own: on base-union, `git merge` is clean at 5
# records; on base-plain it conflicts. Both bases run the SAME operation here, so any difference
# isolates the merge driver rather than the layout.
#
# Readings are taken from records.jsonl ON DISK, and both appends are reported by name -- the
# failure this series hunts is well-formed JSONL with the other side's append silently gone. On a
# conflicted cell the two unmerged stages are read with `git show :2:` (ours) and `:3:` (theirs),
# so the naive-resolution cost is measured without touching the tree.
#
# Usage: union-rebase-arms.sh <seed-dir>     (build one with: union-fixture.sh <dir>)
set -u

SEED="${1:?usage: union-rebase-arms.sh <seed-dir>}"
WORK="$(mktemp -d /tmp/asc-union-rebase-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "git version: $(git --version)"
echo "seed: $SEED"
echo

# One field of a blob: the record count and whether an append survived.
fact() { # <text> <pattern> -> "present"/"ABSENT"
  if printf '%s' "$1" | grep -q "$2"; then echo present; else echo ABSENT; fi
}

report() { # <dir> <label>
  local d="$1" label="$2" text lines ra0 rb0 mark
  text="$(cat "$d/records.jsonl" 2>/dev/null)"
  lines="$(printf '%s' "$text" | grep -c . || true)"
  ra0="$(fact "$text" '"ra0"')"
  rb0="$(fact "$text" '"rb0"')"
  mark="$(printf '%s' "$text" | grep -q '<<<<<<<' && echo PRESENT || echo none)"
  local attr
  attr="$(git -C "$d" check-attr merge -- records.jsonl 2>/dev/null | sed 's/.*: //')"
  printf '  %-22s merge=%-12s %2s lines, ra0 %-6s rb0 %-6s markers %s\n' \
    "$label" "$attr" "$lines" "$ra0" "$rb0" "$mark"

  # A conflicted cell: what each naive one-sided resolution would cost. BOTH stages are shown,
  # because `ours`/`theirs` are INVERTED under rebase -- in a rebase stage 2 is the upstream commit
  # being rebased onto and stage 3 is the commit being replayed, the opposite of a merge. Printing
  # one side per arm read as "no loss" on the rebase cell, which is exactly wrong.
  if [ "$mark" = "PRESENT" ]; then
    local ours theirs
    ours="$(git -C "$d" show :2:records.jsonl 2>/dev/null || echo '')"
    theirs="$(git -C "$d" show :3:records.jsonl 2>/dev/null || echo '')"
    printf '  %-22s -> stage2 keeps ra0 %-6s rb0 %-6s | stage3 keeps ra0 %-6s rb0 %s\n' \
      '' "$(fact "$ours" '"ra0"')" "$(fact "$ours" '"rb0"')" \
      "$(fact "$theirs" '"ra0"')" "$(fact "$theirs" '"rb0"')"
  fi
}

# A counter, not the base/op pair, in the directory name: two calls with the same (base, op) --
# `cell union rebase` in both the main table and the backends block -- otherwise clone into the
# same path, and `git clone` refuses a non-empty target, so `|| return` drops the row and the arm
# reports fewer cells than it ran.
N=0
cell() { # <base> <op> [extra rebase flags]
  local base="$1" op="$2" extra="${3:-}"
  N=$((N + 1))
  local d="$WORK/$base-$op$N"
  git clone -q "$SEED" "$d" 2>/dev/null || { echo "  CLONE FAILED: $d"; return; }
  git -C "$d" config user.email probe@example.invalid
  git -C "$d" config user.name asc-probe

  local rc=0
  case "$op" in
    merge)
      git -C "$d" checkout -q -B probe "origin/base-$base"
      git -C "$d" merge -q --no-edit "origin/a-base-$base" >/dev/null 2>&1
      git -C "$d" merge -q --no-edit "origin/b-base-$base" >/dev/null 2>&1 || rc=$? ;;
    rebase)
      git -C "$d" checkout -q -B probe "origin/a-base-$base"
      # shellcheck disable=SC2086
      git -C "$d" rebase $extra "origin/b-base-$base" >/dev/null 2>&1 || rc=$? ;;
    cherry-pick)
      git -C "$d" checkout -q -B probe "origin/base-$base"
      # `git cherry-pick` has no -q; passing one exits 129 (usage) and leaves the tree untouched,
      # which reads exactly like a clean merge with no appends -- the false-reading class this
      # series keeps meeting. Measured: exit 129 on BOTH bases before this was fixed.
      git -C "$d" cherry-pick "origin/a-base-$base" >/dev/null 2>&1 || rc=$?
      git -C "$d" cherry-pick "origin/b-base-$base" >/dev/null 2>&1 || rc=$? ;;
  esac
  report "$d" "$op${extra:+ ${extra}} (exit $rc)"
}

for base in union plain; do
  echo "=== base-$base ==="
  cell "$base" merge
  cell "$base" rebase
  cell "$base" cherry-pick
  echo
done

echo "=== rebase backends, base-union (the driver is backend-dependent in principle) ==="
cell union rebase
cell union rebase "--merge"
cell union rebase "--apply"
