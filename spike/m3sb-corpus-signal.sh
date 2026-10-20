#!/bin/sh
# What the ten-clone corpus actually offers, per repository -- the scoping measurement for `asc-m3sb`
# ("Design: mine long-standing public repos for betterment priors").
#
# WHY IT IS IN THE REPO. The bead's design rests on link rates and on whether an agent-era slice
# exists at all, and `asc-0qbw` is this repository's record of a measurement that survived only in a
# temp tree. A design input that cannot be re-run is a claim, not a measurement.
#
# WHAT IT COUNTS, per clone under ~/temp/enterprise-apps (override with CORPUS=), git only, no API,
# no model spend:
#
#   commits        `git rev-list --all --count`.
#   pr_subject     subjects ending in a squash-merge PR reference, `\(#1234\)$`. This is the design's
#                  section 3 commit-to-PR link rate, measured before anything is built on it.
#   agent_trailer  commit bodies carrying `Co-Authored-By:` naming a model (claude, copilot, codex,
#                  gemini, cursor). This is the section 4 "agent-era slice", which the bead records
#                  as unmeasured. It over-counts when a human co-author is a model vendor's bot and
#                  under-counts when no trailer is used; it is a lower bound with a known shape.
#   reverts        subjects starting `Revert `. The section 2 revert-rate outcome, by subject only --
#                  a revert whose subject does not say so is not counted, so this is also a floor.
#
# Measured 2026-10-19: 469,785 commits, PR-subject 26.12%, agent-trailer 4.76%, reverts 0.66%, with
# per-repo rates from 0.05% (nest, PR subject) to 70.62% (nx, PR subject) and agent trailers at 17.40%
# in n8n and 6.43% in vscode against 0.00% in cdk8s.
set -eu
ROOT="${CORPUS:-$HOME/temp/enterprise-apps}"
printf '%s\n' 'repo	commits	pr_subject	agent_trailer	reverts'
for d in "$ROOT"/*/; do
  [ -d "$d/.git" ] || continue
  name=$(basename "$d")
  total=$(git -C "$d" rev-list --all --count 2>/dev/null || echo 0)
  [ "$total" = "0" ] && continue
  pr=$(git -C "$d" log --all --format=%s 2>/dev/null | grep -cE '\(#[0-9]+\)$' || true)
  agent=$(git -C "$d" log --all --format=%B 2>/dev/null \
    | grep -ciE 'co-authored-by:.*(claude|copilot|codex|gemini|cursor)' || true)
  reverts=$(git -C "$d" log --all --format=%s 2>/dev/null | grep -cE '^Revert ' || true)
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$total" "$pr" "$agent" "$reverts"
done
