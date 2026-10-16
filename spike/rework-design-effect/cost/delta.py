# asc-09wx.12: the commits the commit map gained since the last trace, in blame.py's input format.
#
# The traces are not free to re-run -- `blame.py` blames every hunk of every fix commit -- but they do
# not need to be. `blame.py`'s rows for a commit depend only on that commit and the NOT_SOURCE filter,
# never on the list it arrived in, so a commit traced under any earlier list is already covered. What
# is missing is exactly the source-bearing commits that appear in a refreshed commit map and in no
# existing trace, which is what this writes.
#
# The `at` column is passed straight through to `blame.py` and becomes each row's `rw_at`, so it must
# carry the SAME field as the commit map being measured -- otherwise `rw_at - c['at']` subtracts two
# different clocks. Hence one output per field.
#
#   python3 -I delta.py <ev63-dir> <cost-dir> <snap-subdir> <field> <out-dir> [all]
#
# `all` ignores what earlier runs traced and lists the whole source-bearing history. That mode exists
# because a trace bakes its `at` into every row it emits, so an `.out` written under one timestamp
# field cannot be mixed with a commit map dumped under the other: the window test `rw_at - c['at']`
# would subtract two different clocks. Re-tracing everything under one field is the only way to have
# one clock end to end, and at the measure rate this is minutes.
import glob, os, re, subprocess, sys

ev63, costdir, snap, field, outdir = sys.argv[1:6]
whole = len(sys.argv) > 6 and sys.argv[6] == 'all'
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)
TRACED = ('ascend', 'grizzly-pl', 'mast', 'spindle')
PATHS = {'ascend': '/Users/spikedpunchvictim/projects/ascend',
         'grizzly-pl': '/Users/spikedpunchvictim/projects/grizzly/grizzly-pl',
         'mast': '/Users/spikedpunchvictim/projects/mast',
         'spindle': '/Users/spikedpunchvictim/projects/spindle'}
for n in ('grizzly-exp', 'grizzly-sv', 'grizzly-wip', 'grizzly-platform'):
    PATHS[n] = f'/Users/spikedpunchvictim/projects/grizzly/{n}'

def parse(path):
    cs = {}
    for rec in open(path, encoding='utf-8', errors='replace').read().split('\x1e')[1:]:
        f = rec.split('\x1f')
        if len(f) < 4:
            continue
        lines = [l.split('\t') for l in f[3].strip().split('\n') if l.count('\t') == 2]
        cs[f[0]] = dict(at=int(f[1]), files=[(x[2], int(x[0])) for x in lines if x[0].isdigit()])
    return cs

def src(c):
    return any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])

def already(n):
    """Every commit any earlier run traced for this repo -- the `rw` column of its `.out` files."""
    seen = set()
    for path in glob.glob(f'{costdir}/t/*.{n}.out') + ([f'{ev63}/{n}/traced.tsv'] if n in TRACED else []):
        try:
            fh = open(path, encoding='utf-8', errors='replace')
        except OSError:
            continue
        for line in fh:
            cols = line.rstrip('\n').split('\t')
            if len(cols) == 5:
                seen.add(cols[0])
    return seen

total = 0
for n in PATHS:
    new = parse(f'{costdir}/snap/{snap}/{n}.numstat.log')
    done = set() if whole else already(n)
    sel = [s for s in new if src(new[s]) and s not in done]
    # blame needs <sha>^ ; a root commit has no parent to diff against.
    sel = [s for s in sel if subprocess.run(['git', '-C', PATHS[n], 'rev-parse', '-q', '--verify',
                                             s + '^'], capture_output=True).returncode == 0]
    # The field is IN the filename. It was not once, and the second run silently overwrote the first:
    # both fields produce the same commit SET, so nothing about the list looks wrong -- only the `at`
    # column, which is the one thing a trace bakes in and cannot be recovered afterwards.
    dest = f'{outdir}/D.{field}.{n}.tsv'
    open(dest, 'w').write('\n'.join(f'{s}\t{new[s]["at"]}' for s in sel) + ('\n' if sel else ''))
    total += len(sel)
    print(f'  {field} {n:17s} commits in map {len(new):5d}  already traced {len(done):5d}  new {len(sel):4d}')
print(f'total to trace for %{field}: {total}')
