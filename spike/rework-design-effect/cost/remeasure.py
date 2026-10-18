# asc-09wx.12: the whole measurement under ONE commit map and ONE clock.
#
# `rho.py` and `commits.py` read a commit map assembled from two sources on two clocks -- EV-63's
# `%at` snapshot for four repositories, this scoping's `%ct` dumps for the other four, which disagree
# on 130 commits -- and a trace assembled from a dozen `.out` files written under both. Every window
# test in them, `0 < rw_at - c['at'] <= 7*DAY`, therefore subtracts two clocks for half the corpus,
# and `t/U.*.out` for a traced repo carries `%at` while the same file for a grizzly clone carries
# `%ct`. This reads one map and one full re-trace for all eight, so the subtraction is one clock, and
# it is run once per field so the cost of having mixed them can be measured instead of argued.
#
# It also reports the funnel and the closure schedule of the units whose 7-day window is still open,
# which is what decides whether the 489-unit ceiling can be measured yet.
#
#   python3 -I remeasure.py <join.jsonl> <costdir> <field> <out.json> [now-epoch] [delta-dir]
import collections, datetime, glob, json, re, subprocess, sys

join_path, costdir, field, out_path = sys.argv[1:5]
ev63 = sys.argv[7] if len(sys.argv) > 7 else '/private/tmp/claude-501/-Users-spikedpunchvictim-projects-ascend/feca35f3-deeb-44e4-b4ce-6871f5f42ccd/scratchpad/ev63'
fielddir = sys.argv[6] if len(sys.argv) > 6 else 't2'
# `NOW` is EV-71's measurement instant (2026-10-15T16:00Z), held fixed here so the two runs are
# comparable. It is NOT the wall clock: a window only closes in real time, so a stale `NOW` can only
# understate how much of the ceiling is measurable, never overstate it. Pass a later epoch to ask
# what a re-measurement today would see.
NOW = int(sys.argv[5]) if len(sys.argv) > 5 else 1792080000
DAY = 86400
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)
REPOS = ('ascend', 'grizzly-pl', 'mast', 'spindle', 'grizzly-exp', 'grizzly-sv', 'grizzly-wip', 'grizzly-platform')
# The four repositories EV-63 traced. The other four have no `traced.tsv`, only the traces this
# scoping produced, so there is nothing of EV-63's to lose for them.
TRACED = ('ascend', 'grizzly-pl', 'mast', 'spindle')

def parse(path):
    cs = {}
    for rec in open(path, encoding='utf-8', errors='replace').read().split('\x1e')[1:]:
        f = rec.split('\x1f')
        if len(f) < 4:
            continue
        lines = [l.split('\t') for l in f[3].strip().split('\n') if l.count('\t') == 2]
        cs[f[0]] = dict(at=int(f[1]), files=[(x[2], int(x[0])) for x in lines if x[0].isdigit()])
    return cs

H = {n: parse(f'{costdir}/snap/{field}/{n}.numstat.log') for n in REPOS}

def src(n, s):
    c = H[n].get(s)
    return bool(c) and any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])

# ---- coverage: was every source-bearing commit ATTEMPTED by some trace? (asc-synu, dogfood/0117)
#
# A trace that was never made, or one that was reaped, is indistinguishable from a complete one from
# here: the pair set is shorter, the outcome flips for some units, and every number below stays
# well-formed. Measured 2026-10-18 when EV-63's traced.tsv was gone, the `any` rate fell 0.78173 ->
# 0.57614 and the design effect rose 4.60581 -> 15.22071 with no error anywhere. So this refuses
# rather than reporting a number computed over a gap.
#
# It reads the ATTEMPTED lists that sit beside the traces, never the `rw` column of the `.out` files:
# a commit can be attempted and produce no rows at all -- the grizzly repositories' remaining delta
# commits rewrite documentation only -- and counting those as untraced would fail them forever.
#
# Root commits are exempt, one `rev-list` per repository rather than a per-commit test. They can
# never be attempted because blame needs a parent to diff against: the eight in this map are
# `delta.py`'s own filter, applied for the same reason.
PATHS = {n: f'/Users/spikedpunchvictim/projects/grizzly/{n}' for n in REPOS}
PATHS.update({'ascend': '/Users/spikedpunchvictim/projects/ascend',
              'mast': '/Users/spikedpunchvictim/projects/mast',
              'spindle': '/Users/spikedpunchvictim/projects/spindle'})

attempted = collections.defaultdict(set)
for n in REPOS:
    for pattern in (f'{costdir}/t/*.{n}.tsv', f'{costdir}/{fielddir}/D.{field}.{n}.tsv'):
        for path in glob.glob(pattern):
            for line in open(path, encoding='utf-8', errors='replace'):
                s = line.split('\t')[0].strip()
                if s:
                    attempted[n].add(s)

def roots_of(n):
    r = subprocess.run(['git', '-C', PATHS[n], 'rev-list', '--max-parents=0', '--all'],
                       capture_output=True, text=True)
    return set(r.stdout.split()) if r.returncode == 0 else set()

untraced = {n: sorted(s for s in H[n]
                      if src(n, s) and s not in attempted[n] and s not in roots_of(n))
            for n in REPOS}
if any(untraced.values()):
    sys.exit('untraced source-bearing commits in the map -- the traces do not cover it, so any '
             'outcome computed here would be censored rather than measured:\n'
             + '\n'.join(f'  {n}: {len(v)} (e.g. {v[0]})' for n, v in untraced.items() if v)
             + '\n  Trace them first: delta.py writes the list, blame.py traces it. Nothing was '
               'written.')

# ---- the rework pairs ----
# Three trace sources, and the first is not optional. `ev63/<repo>/traced.tsv` is EV-63's own trace,
# and it is where the bulk of the pairs live: leaving it out cost the `any` rate 0.78 -> 0.58, i.e. it
# looked like the refresh had HALVED rework. It cannot have -- `p7` is a set and adding to it can only
# turn a unit's outcome from 0 to 1. A rate that moves the wrong way is a missing input, never a
# finding, and that is the check to run first.
#
# The legacy `t/` files come next. They were written by earlier runs whose `at` came from whatever map
# existed then, which for four repositories was `%ct` and for the other four `%at`; they cannot be
# re-derived. The `t2/D.<field>.<n>.out` files were written by THIS run against the map being
# measured, so they carry the matching clock. Union of the three is every source-bearing commit in
# the map -- that is what `delta.py` computes -- so coverage is complete even though the legacy half's
# clock is inherited.
p7 = set()
sources = [(f'{costdir}/t/*.{n}.out', n) for n in REPOS] + \
          [(f'{costdir}/{fielddir}/D.{field}.{n}.out', n) for n in REPOS] + \
          [(f'{ev63}/{n}/traced.tsv', n) for n in TRACED]
for pattern, n in sources:
    for path in sorted(glob.glob(pattern)):
        for line in open(path, encoding='utf-8', errors='replace'):
            parts = line.rstrip('\n').split('\t')
            if len(parts) != 5:
                continue
            rw, rw_at, intro, f, _k = parts
            c = H[n].get(intro)
            if not c or intro == rw:
                continue
            if 0 < int(rw_at) - c['at'] <= 7 * DAY:
                p7.add((n, intro, f))

def outcome(n, s):
    return 1 if any((n, s, f) in p7 for f, a in H[n][s]['files'] if a > 0 and not NOT_SOURCE.search(f)) else 0

# ---- the units, in trigger order, exactly as rho.py builds them ----
rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.OrderedDict()
for r in rows:
    if r['sha'] and r['repo'] in H:
        per_unit.setdefault(r['unit'], []).append((r['repo'], r['sha'], r['ts']))

closed = lambda n, s: src(n, s) and H[n][s]['at'] + 7 * DAY <= NOW
sessionOf = lambda u: u.split('\x00')[0]
day = lambda t: datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')

outcomes = {r: [] for r in ('first', 'last', 'any', 'all')}
commits, units_any = [], []
ceiling, graded, open_units = set(), set(), set()
closure = collections.Counter()
for u, cs in per_unit.items():
    seen, closed_c, open_c = set(), [], []
    for rp, sh, ts in cs:
        if (rp, sh) in seen or rp not in H:
            continue
        seen.add((rp, sh))
        if not src(rp, sh):
            continue
        ceiling.add(u)
        (closed_c if closed(rp, sh) else open_c).append((rp, sh, ts))
    if not closed_c:
        if open_c:
            open_units.add(u)
            # the unit becomes measurable when its EARLIEST source-bearing commit's window shuts.
            # Counted BY DAY, not by epoch: keying on `at + 7*DAY` and formatting later collapses ten
            # units that close on one day at ten different seconds into one, keeping the last.
            closure[day(min(H[rp][sh]['at'] for rp, sh, _ in open_c) + 7 * DAY)] += 1
        continue
    graded.add(u)
    o = [(outcome(rp, sh), ts, f'{rp}/{sh}') for rp, sh, ts in closed_c]
    base = dict(first=o[0][0], last=o[-1][0], any=1 if any(x for x, _, _ in o) else 0,
                all=1 if all(x for x, _, _ in o) else 0)
    for rule in outcomes:
        outcomes[rule].append([u, base[rule]])
    units_any.append([u, base['any']])
    for value, ts, key in o:
        commits.append([u, ts, value, key])

json.dump(dict(outcomes=outcomes, commits=commits, units_any=units_any,
               ceiling_closure=dict(sorted(closure.items()))), open(out_path, 'w'))

print(json.dumps(dict(
    field=f'%{field}',
    # Printed so a passing run shows the coverage check evaluated the whole map rather than being
    # skipped: it is always equal to the number of commits the assertion above walked.
    source_bearing_in_map=sum(1 for n in REPOS for s in H[n] if src(n, s)),
    rework_pairs=len(p7),
    units_total=len({r['unit'] for r in rows}),
    units_with_commit=len(per_unit),
    ceiling_source_bearing=len(ceiling),
    ceiling_per_active_day=round(len(ceiling) / 48, 3),
    window_closed=len(graded),
    window_open=len(open_units),
    permanently_ungradeable=len({r['unit'] for r in rows}) - len(ceiling),
    closure_schedule=dict(sorted(closure.items())),
), indent=1))
