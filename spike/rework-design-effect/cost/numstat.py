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
# A REBUILD IS CHECKED AGAINST THE MAP IT REPLACES (asc-7e9u, dogfood/0116). The commit map is
# reconstructed from the same repositories on every pass, so a mistake in the rebuild and a change in
# the source look identical to everything downstream: the harnesses consume the map and cannot see how
# it was made, and EV-63's cross-check stays green on a map that has simply lost a repository's
# commits. The only check available is against the previous copy, and it is the one thing a re-run
# never needs and a rebuild always does. So when `out_path` already holds a map, this refuses to
# replace it with one that is not a superset of it. The comparison happens BEFORE the write, so a
# refusal leaves the old file exactly as it was rather than half-overwritten.
#
# It compares COMMIT IDS and whether each carried any numstat rows, and nothing else, which is what
# makes it clock-independent -- both fields produce the same id set, so it is silent on the `%at`/`%ct`
# split by construction. That is its blind spot as much as its design: EV-73 needed a byte-level
# reproduction of all eight dumps to find the clock split, because no superset test can see it.
#
# "SUPERSET" MEANS OVER COMMITS THAT CARRIED FILES, and the refinement is measured rather than
# defensive. A record with an empty body has no file for a unit to join on, so `src()` is false for it,
# `delta.py` never selects it to trace, and it cannot move the ceiling, a rate or an outcome: dropping
# it is provably inert. Commits as such are not, because in THIS repository they churn -- GitButler
# rewrites the Workspace Commit on every operation, so it is reachable from no ref once the workspace
# moves on. Measured 2026-10-18: `snap/at/ascend.numstat.log` holds 401 commits, the rebuild holds
# 403, and the one commit the rebuild drops is `6bb7e039` "GitButler Workspace Commit" with an empty
# body. A rule written over commit ids alone would demand `--allow-shrink` on every rebuild of
# ascend's own map, and a flag whose reason is always the same is a flag that gets rubber-stamped.
#
# A repository can still legitimately lose real commits -- a force-push that rebases a branch away, a
# `git gc` that prunes an unreachable ref. From here that is indistinguishable from a wrong refspec,
# so it is not guessed at: it has to be stated, with a reason, as `--allow-shrink`, and it is printed.
#
# Read-only against the repository. Usage:
#   python3 -I numstat.py <repo-path> <out.log> [at|ct] [--allow-shrink <reason>]
import os, subprocess, sys

args = sys.argv[1:]
reason = None
if '--allow-shrink' in args:
    i = args.index('--allow-shrink')
    if i + 1 == len(args):
        sys.exit('--allow-shrink needs a reason: a map that shrank is a claim, not a flag')
    reason = args[i + 1]
    del args[i:i + 2]
if len(args) < 2:
    sys.exit('usage: numstat.py <repo-path> <out.log> [at|ct] [--allow-shrink <reason>]')
repo, out_path = args[0], args[1]
field = args[2] if len(args) > 2 else 'at'
if field not in ('at', 'ct'):
    sys.exit(f'timestamp field must be `at` (author) or `ct` (committer), not {field!r}')

def records(text):
    """sha -> whether the record carried numstat rows, i.e. whether anything could join on it."""
    out = {}
    for rec in text.split('\x1e')[1:]:
        f = rec.split('\x1f')
        if f[0]:
            # Fail closed: a record too short to have a body counts as one that HAD files, so a
            # truncated dump is refused rather than written off as inert.
            out[f[0]] = True if len(f) < 4 else bool(f[3].strip())
    return out

def held(path):
    """What a dump already holds, or None if there is no dump there yet."""
    try:
        return records(open(path, encoding='utf-8', errors='replace').read())
    except OSError:
        return None

# The separators are git's own %x1e/%x1f so the format is produced by git and never reassembled by
# hand: a body containing a separator byte cannot be constructed here, only passed through.
fmt = f'%x1e%H%x1f%{field}%x1f%s%x1f\n'
raw = subprocess.run(['git', '-C', repo, 'log', '--all', '--numstat', '--no-renames', '--no-color',
                      f'--pretty=format:{fmt}'],
                     capture_output=True, text=True, errors='replace')
if raw.returncode != 0:
    sys.exit(f'git log failed in {repo}: {raw.stderr.strip()}')

new, old = records(raw.stdout), held(out_path)
missing = {} if old is None else {s: r for s, r in old.items() if s not in new}
lost = {s for s, rows in missing.items() if rows}
if lost and reason is None:
    sys.exit(
        f'{out_path} holds {len(old)} commits, this dump holds {len(new)}, and {len(lost)} of the old '
        f'ones that carried files are not in it (e.g. {sorted(lost)[0]}).\n'
        f'  A rebuilt commit map can only ADD to the map it replaces. A dump that drops commits is '
        f'either a dump that followed the wrong refspec -- `--all` is load-bearing, grizzly-wip is 835 '
        f'commits on HEAD against 1,884 across all refs -- or a repository that lost history, and from '
        f'here the two are identical. Nothing was written.\n'
        f'  If the repository really did lose history, state it: --allow-shrink "<reason>"')

open(out_path, 'w', encoding='utf-8').write(raw.stdout)
if old is None:
    change = ''
else:
    gained, inert = len(new.keys() - old.keys()), len(missing) - len(lost)
    change = (f' (+{gained} new, {len(lost)} dropped with files'
              f'{"" if not lost else f", allowed: {reason}"}'
              f'{"" if not inert else f", {inert} empty-bodied dropped"})')
print(f'{out_path}: {len(new)} commits, {len(raw.stdout) / 1e6:.2f} MB{change}')
