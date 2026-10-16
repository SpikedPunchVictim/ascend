# asc-09wx.12: dump one repository's commit history in the numstat.log format the harnesses parse.
#
# `rho.py` and `measure.py` read `<record-separator>sha<us>at<us>subject<us><numstat body>` from
# `ev63/<repo>/numstat.log`. The four TRACED repositories read EV-63's snapshot of that file, which
# stops at 2026-10-13T06:20:34Z; the four untraced grizzly clones were re-dumped during this session.
# This re-dumps any of them, so the commit map covers the whole transcript window.
#
# TWO DETAILS ARE NOT FREE CHOICES, and both were recovered by reproducing the existing dumps rather
# than by reading them. The `\n` ending the format string is what puts the blank line before the
# numstat block rather than after it; with it, the dumps are byte-identical to the ones they replace.
#
# The TIMESTAMP FIELD is the second, and it is NOT settled -- the existing dumps disagree with each
# other. EV-63's four TRACED snapshots record `%at`, the author date: ascend's 1f765ce3e4d1 holds
# 1789713547, which is `%at`, while its `%ct` is 1789713993. The four grizzly clones were dumped
# during this scoping with `%ct`, the committer date: grizzly-exp's 29095b9aa6dc holds 1791232802,
# which is `%ct`, while its `%at` is 1791232792. So the eight repositories' commit maps were built on
# two different clocks, and every measurement that reads both mixed them. Both are dumped and the
# field is a parameter, so the choice can be measured rather than assumed.
#
# `--all` IS LOAD-BEARING, and this was got wrong once. Without it the dump follows only the checked
# -out branch, and on these repositories that is a fraction of the history: grizzly-wip is 835
# commits on HEAD against 1,884 across all refs. The dumps being replaced are the `--all` form, which
# is why they reproduce exactly and a HEAD-only dump does not -- and a HEAD-only dump is not merely
# smaller, it drops source-bearing commits, which drops units out of the ceiling and makes a fresh
# measurement look BETTER than the one it replaces. `spike/rework-design-effect/cost/numstat.py` is
# the only place this refspec is chosen, so it is chosen here and nowhere else.
#
# Read-only against the repository. Usage: python3 -I numstat.py <repo-path> <out.log> [at|ct]
import subprocess, sys

repo, out_path = sys.argv[1], sys.argv[2]
field = sys.argv[3] if len(sys.argv) > 3 else 'at'
if field not in ('at', 'ct'):
    sys.exit(f'timestamp field must be `at` (author) or `ct` (committer), not {field!r}')
# The separators are git's own %x1e/%x1f so the format is produced by git and never reassembled by
# hand: a body containing a separator byte cannot be constructed here, only passed through.
fmt = f'%x1e%H%x1f%{field}%x1f%s%x1f\n'
raw = subprocess.run(['git', '-C', repo, 'log', '--all', '--numstat', '--no-renames', '--no-color',
                      f'--pretty=format:{fmt}'],
                     capture_output=True, text=True, errors='replace')
if raw.returncode != 0:
    sys.exit(f'git log failed in {repo}: {raw.stderr.strip()}')
open(out_path, 'w', encoding='utf-8').write(raw.stdout)
records = raw.stdout.split('\x1e')[1:]
print(f'{out_path}: {len(records)} commits, {len(raw.stdout) / 1e6:.2f} MB')
