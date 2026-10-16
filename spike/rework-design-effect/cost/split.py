# asc-09wx.12 scoping (throwaway): the (a)/(b) split behind the 852 units, and the ceiling.
#
# Read-only. Usage: python3 -I split.py <join.jsonl> <ev63-dir> <cost-dir> <out.json>
import collections, json, re, sys

join_path, ev63, costdir, out_path = sys.argv[1:5]
DAY = 86400
NOW = 1792099200  # 2026-10-15T00:00:00Z, the replay's own last day
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)

TRACED = ('ascend', 'grizzly-pl', 'mast', 'spindle')
UNTRACED = ('grizzly-exp', 'grizzly-sv', 'grizzly-wip', 'grizzly-platform')

def load_numstat(path):
    commits = {}
    raw = open(path, encoding='utf-8', errors='replace').read()
    for rec in raw.split('\x1e')[1:]:
        p = rec.split('\x1f')
        if len(p) < 4:
            continue
        lines = [l.split('\t') for l in p[3].strip().split('\n') if l.count('\t') == 2]
        files = [(f[2], int(f[0])) for f in lines if f[0].isdigit()]
        commits[p[0]] = dict(at=int(p[1]), files=files, n_files=len(lines))
    return commits

hist = {}
for name in TRACED:
    hist[name] = load_numstat(f'{ev63}/{name}/numstat.log')
for name in UNTRACED:
    hist[name] = load_numstat(f'{costdir}/{name}.numstat.log')

# The eligibility rule of effect.py/analyse.py, decomposed into why-not.
def why(name, sha, now=NOW):
    c = hist.get(name, {}).get(sha)
    if c is None:
        return 'unknown'            # not in this repo's non-merge history (or outside the window)
    src = [(f, a) for f, a in c['files'] if a > 0 and not NOT_SOURCE.search(f)]
    if not src:
        return 'a_no_source'        # (a): nothing to rewrite; compute cannot recover
    if c['n_files'] > 30:
        return 'b_over30'           # (b): source, excluded by the file cap
    if c['at'] > now - 7 * DAY:
        return 'c_recent'           # (b'): source, inside the 7-day window the outcome needs
    return 'ok_eligible'

rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.defaultdict(list)
for r in rows:
    if r['sha'] is None or r['repo'] is None:
        continue
    per_unit[r['unit']].append((r['repo'], r['sha']))

all_units = {r['unit'] for r in rows}
UNIT_ORDER = ['ok_eligible', 'c_recent', 'b_over30', 'a_no_source', 'unknown']
def best(cs):
    st = {why(repo, sha) for repo, sha in cs}
    for s in UNIT_ORDER:
        if s in st:
            return s
    return 'none'

units_by = collections.Counter()
commits_by = collections.Counter()
for u, cs in per_unit.items():
    units_by[best(cs)] += 1
    seen = set()
    for repo, sha in cs:
        if (repo, sha) in seen:
            continue
        seen.add((repo, sha))
        commits_by[why(repo, sha)] += 1
units_by['no_commit_at_all'] = len(all_units) - len(per_unit)

# per-repo commit-population facts
pop = {}
for name, cs in hist.items():
    last = max(c['at'] for c in cs.values())
    kinds = collections.Counter()
    for sha in cs:
        st = why(name, sha, now=min(NOW, last))
        kinds[st] += 1
    pop[name] = dict(commits=len(cs), last=last, **{k: kinds[k] for k in UNIT_ORDER})

# The windowed universe each axis must trace: the four traced repos' full non-merge history and
# the four untraced clones'. Split each by the same four kinds.
def axis_universe(names):
    u = collections.Counter()
    for n in names:
        for sha in hist[n]:
            u[why(n, sha, now=min(NOW, max(c['at'] for c in hist[n].values())))] += 1
    return dict(u)

# commits the units actually name (distinct), by axis
def named_commits(names):
    got = set()
    for u, cs in per_unit.items():
        for repo, sha in cs:
            if repo in names:
                got.add((repo, sha))
    return got

out = dict(units=dict(units_by), commits=dict(commits_by), per_repo=pop,
           universe=dict(traced=axis_universe(TRACED), untraced=axis_universe(UNTRACED)),
           named=dict(traced=len(named_commits(TRACED)), untraced=len(named_commits(UNTRACED))),
           named_by_kind=dict(
               traced=dict(collections.Counter(why(r, s) for r, s in named_commits(TRACED))),
               untraced=dict(collections.Counter(why(r, s) for r, s in named_commits(UNTRACED)))))
json.dump(out, open(out_path, 'w'), indent=1)
print('UNITS by best joined commit:')
for k in UNIT_ORDER + ['no_commit_at_all', 'none']:
    if units_by[k]:
        print(f'   {k:16s} {units_by[k]}')
print('UNITS total', len(all_units), 'with joined commit', len(per_unit))
print('COMMITS named by units (distinct):')
for k in UNIT_ORDER:
    if commits_by[k]:
        print(f'   {k:16s} {commits_by[k]}')
print('PER REPO (whole non-merge history in the traced window / all for untraced):')
for n, v in pop.items():
    print(f'   {n:16s} commits={v["commits"]:6d} eligible={v["ok_eligible"]:5d} recent={v["c_recent"]:4d} '
          f'over30={v["b_over30"]:4d} nosrc={v["a_no_source"]:5d} unknown={v["unknown"]:3d}')
print('UNIVERSE to trace:')
print('   traced  ', json.dumps(out['universe']['traced']))
print('   untraced', json.dumps(out['universe']['untraced']))
print('NAMED (the commits the 852 units actually reference):')
print('   traced  ', out['named']['traced'], json.dumps(out['named_by_kind']['traced']))
print('   untraced', out['named']['untraced'], json.dumps(out['named_by_kind']['untraced']))
