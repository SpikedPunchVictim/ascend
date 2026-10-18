# asc-560h: the commit tracer EV-63 used, rebuilt -- because the original no longer exists.
#
# WHAT IT DOES. For each commit in a list, it asks which EARLIER commit's lines that commit replaced,
# and writes one row per (commit, blamed commit, file) with the number of lines. That is the
# `rw<us>rw_at<us>intro<us>file<us>count` format remeasure.py and rho.py read, where the window test
# `0 < rw_at - intro.at <= 7*DAY` decides whether the later commit reworked the line.
#
# WHY IT EXISTS. EV-63's tracer, its `list.tsv` and its `traced.tsv` lived only in an OS temp tree,
# which `asc-0qbw` predicted macOS would reap. On 2026-10-18 it had: the scratchpad held 0 files, and
# `traced.tsv` was the only copy of the rows for the commits the other lists deliberately skip
# (`gen_seeds.py` built `U` with `only_unfed=True`). Re-running remeasure.py without those rows takes
# the `any` rate from 0.78173 to 0.57614 and the design effect from 4.61 to 15.22 -- silently, because
# a map missing a trace still looks complete and nothing downstream can tell. This file is the
# recovery, and it lives in the repo so the next reaping costs nothing.
#
# TWO DETAILS ARE NOT GUESSES. Both were recovered by requiring this to reproduce the traces that
# survived, and both were wrong on the first attempt:
#   * BOTH the diff and the blame ignore whitespace (`-w`). With `-w` on the blame alone, whitespace
#     -only edits were counted as replaced lines and the counts ran high on every repo.
#   * The file key comes from the OLD side (`--- a/<path>`), because the blame runs on the parent,
#     where the old path is the one that exists -- and a deleted file has no new path to key on.
#     Keying on `+++ b/<path>` silently dropped every deletion: 75 rows on one ascend commit alone.
# The path filter is EV-63's outcome-side NOT_SOURCE: join.py's list plus .jsonl/.csv/.tsv/.log and
# .ascend//.beads/, which join.py's own comment attributes to the outcome side.
#
# FIDELITY, measured against the surviving traces rather than asserted: a stratified sample of 25
# commits from each of the 16 surviving (tag, repo) lists -- every commit where a list is that
# short -- reproduces 322/322 exactly, with no extra row anywhere. The eight lists small enough to
# run exhaustively reproduce 7 of 8; the exception is one row in 2,992 on U.grizzly-pl, where
# 262b89ede's rewrite of live-browser.js is counted as 2190 lines against EV-63's 1211 (same commit,
# same blamed commit, same file). That column is DEAD: rho.py, measure.py, commits.py, proxy.py and
# remeasure.py all unpack it and none of the five reads it -- the rework test uses only rw_at, intro
# and the file. So the pair set is identical, which is what every measurement consumes.
#
#   python3 -I blame.py <repo> <list.tsv> <out.tsv>
import re, subprocess, sys

repo, list_path, out_path = sys.argv[1:4]
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)

def git(*args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True,
                          errors='replace').stdout

rows = []
for line in open(list_path):
    parts = line.rstrip('\n').split('\t')
    if len(parts) != 2:
        continue
    sha, at = parts
    parent = git('rev-parse', '-q', '--verify', sha + '^').strip()
    if not parent:
        continue
    # ---- which OLD lines this commit replaced, per file ----
    per_file, cur = {}, None
    for line in git('diff', '-w', '-U0', '--no-renames', parent, sha).split('\n'):
        if line.startswith('diff --git '):
            cur = None
        elif line.startswith('--- a/'):
            cur = line[6:]
            per_file.setdefault(cur, [])
        elif cur and line.startswith('@@'):
            m = HUNK.match(line)
            if m:
                start = int(m.group(1))
                per_file[cur].append((start, int(m.group(2)) if m.group(2) is not None else 1))
    # ---- blame the parent for exactly those lines ----
    for path, hunks in per_file.items():
        if NOT_SOURCE.search(path):
            continue
        wanted = {n for start, count in hunks for n in range(start, start + count)}
        if not wanted:
            continue                     # a pure addition replaces nothing
        blame = {}
        for bl in git('blame', '-w', '--line-porcelain', parent, '--', path).split('\n'):
            m = re.match(r'^([0-9a-f]{40}) \d+ (\d+)', bl)
            if m:
                blame[int(m.group(2))] = m.group(1)
        tally = {}
        for n in wanted:
            intro = blame.get(n)
            if intro and intro != sha:
                tally[intro] = tally.get(intro, 0) + 1
        for intro, n in tally.items():
            rows.append(f'{sha}\t{at}\t{intro}\t{path}\t{n}')

open(out_path, 'w').write('\n'.join(rows) + ('\n' if rows else ''))
print(f'{out_path}: {len(rows)} rows from {sum(1 for _ in open(list_path))} commits')
