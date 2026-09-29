#!/usr/bin/env bash
# asc-3ow4: build the fixture the non-CLI merge arms are measured against, and prove it is the
# shape spike/git-layout already found CLEAN under command-line git. If the LOCAL arms below do not
# come out clean-on-union / conflicted-on-plain, the fixture is wrong and nothing measured on a
# forge means anything.
#
# Two bases, because "the second PR conflicts" only means something against a CONTROL:
#   base-union  .gitattributes says `records.jsonl merge=union`
#   base-plain  no .gitattributes at all
# If a forge refuses the second PR under BOTH, the attribute had no effect there -- and without the
# plain base that would be indistinguishable from "forges always conflict".
#
# Branches: <base> is the starting point; a-<base> and b-<base> each append one record FROM IT.
# Usage: union-fixture.sh [dir]
set -euo pipefail

DIR="${1:-$(mktemp -d /tmp/asc-union-XXXXXX)}"
mkdir -p "$DIR"
cd "$DIR"

git init -q -b main
git config user.email probe@example.invalid
git config user.name asc-probe

printf '{"id":"r0"}\n{"id":"r1"}\n{"id":"r2"}\n' > records.jsonl
printf '# throwaway probe for asc-3ow4 (merge=union)\n' > README.md
printf 'records.jsonl merge=union\n' > .gitattributes
git add -A && git commit -qm 'base-union'
git branch -q base-union

git rm -q .gitattributes && git commit -qm 'base-plain'
git branch -q base-plain

# Each side branches from its OWN base. (`git checkout -b` starts from the current HEAD, so the
# base must be checked out first -- creating the second side while standing on the first silently
# puts both appends on one branch and turns the merge into a fast-forward.)
for base in base-union base-plain; do
  for side in a b; do
    git checkout -q "$base"
    git checkout -q -b "${side}-${base}"
    printf '{"id":"r%s0"}\n' "$side" >> records.jsonl
    git commit -qam "append from $side"
  done
done
git checkout -q main

echo "fixture: $DIR"
echo
echo "--- LOCAL ARM (command-line git): the same two merges, union first then the control"

for base in base-union base-plain; do
  git checkout -q "$base"
  git checkout -q -b "local-$base"
  git merge -q --no-edit "a-$base" >/dev/null
  git merge -q --no-edit "b-$base" >/dev/null 2>&1 || true
  driver=$(git check-attr merge -- records.jsonl | sed 's/.*: //')
  if grep -q '^<<<<<<<' records.jsonl; then
    echo "  $base (merge=$driver): CONFLICT"
  else
    echo "  $base (merge=$driver): clean, $(wc -l < records.jsonl | tr -d ' ') records: $(tr -d '\n' < records.jsonl)"
  fi
  git merge --abort 2>/dev/null || true
  git checkout -q "$base"
  git branch -qD "local-$base" >/dev/null
done
git checkout -q main
