# asc-09wx.12: the commit-level observations behind the same units rho.py collapses.
#
# rho.py emits one 0/1 per randomized unit, because the hook randomizes PER SEGMENT (`asc-6ola.4`);
# a segment is held out or delivered whole, so every commit inside one shares its assignment. That
# is cluster-LEVEL analysis, and it is not the only analysis the design admits. Intent-to-treat at
# the COMMIT level, with the variance clustered at the assignment, is the other one -- and it is
# the standard choice for cluster randomization, because collapsing to the cluster discards the
# within-cluster information entirely.
#
# Which of the two is right is a design question, not a measurement one, and this script does not
# answer it. It emits the observations so `commits.mjs` can run the package's own `clusterDesign`
# over both levels. No rho is computed here, deliberately: the arithmetic has one path.
#
# Read-only, over the same join and the same traces rho.py reads. Nothing is copied into the repo.
#
#   python3 -I commits.py <join.jsonl> <ev63> <costdir> <out.json>
import collections, json, re, subprocess, sys

join_path, ev63, costdir, out_path = sys.argv[1:5]
DAY, NOW = 86400, 1792080000
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)
TRACED = ('ascend', 'grizzly-pl', 'mast', 'spindle')
UNTRACED = ('grizzly-exp', 'grizzly-sv', 'grizzly-wip', 'grizzly-platform')
PATHS = {'ascend': '/Users/spikedpunchvictim/projects/ascend',
         'grizzly-pl': '/Users/spikedpunchvictim/projects/grizzly/grizzly-pl',
         'mast': '/Users/spikedpunchvictim/projects/mast',
         'spindle': '/Users/spikedpunchvictim/projects/spindle'}
for n in UNTRACED:
    PATHS[n] = f'/Users/spikedpunchvictim/projects/grizzly/{n}'

def parse(path):
    cs = {}
    for rec in open(path, encoding='utf-8', errors='replace').read().split('\x1e')[1:]:
        p = rec.split('\x1f')
        if len(p) < 4:
            continue
        lines = [l.split('\t') for l in p[3].strip().split('\n') if l.count('\t') == 2]
        cs[p[0]] = dict(at=int(p[1]), n_files=len(lines),
                        files=[(f[2], int(f[0])) for f in lines if f[0].isdigit()])
    return cs

# ---- the WIDENED corpus, loaded exactly as rho.py loads it ----
H = {n: parse(f'{ev63}/{n}/numstat.log') for n in TRACED}
for n in UNTRACED:
    H[n] = parse(f'{costdir}/{n}.numstat.log')
for s, c in parse(f'{costdir}/extra.numstat.log').items():
    for n in TRACED:
        if s in H[n] or subprocess.run(['git', '-C', PATHS[n], 'cat-file', '-e', s + '^{commit}'],
                                       capture_output=True).returncode:
            continue
        H[n][s] = c
        break
def w_src(n, s):
    c = H[n].get(s)
    return bool(c) and any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])
p7w = set()
for n in H:
    paths = ([f'{ev63}/{n}/traced.tsv'] if n in TRACED else []) + [f'{costdir}/t/U.{n}.out']
    for path in paths:
        try:
            fh = open(path, encoding='utf-8', errors='replace')
        except OSError:
            continue
        for line in fh:
            q = line.rstrip('\n').split('\t')
            if len(q) != 5:
                continue
            rw, rw_at, intro, f, _ = q
            c = H[n].get(intro)
            if c and intro != rw and 0 < int(rw_at) - c['at'] <= 7 * DAY:
                p7w.add((n, intro, f))
def w_out(n, s, p7):
    c = H[n][s]
    return 1 if any((n, s, f) in p7 for f, a in c['files'] if a > 0 and not NOT_SOURCE.search(f)) else 0

# ---- every (unit, commit) the widened window-closed population carries ----
rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.OrderedDict()
for r in rows:
    if r['sha'] and r['repo'] in H:
        per_unit.setdefault(r['unit'], []).append((r['repo'], r['sha'], r['ts']))

# `closed` is rho.py's widened predicate, per commit rather than per unit: source lines present AND
# the 7-day window has elapsed. A unit is in the population when at least one of its commits is.
closed = lambda rp, sh: w_src(rp, sh) and H[rp][sh]['at'] + 7 * DAY <= NOW

commits = []      # [unit, ts, outcome, repo/sha] -- one row per (unit, commit) observation
units_any = []    # [unit, outcome] -- rho.py's `any`, re-derived, so the two levels are comparable
keys = collections.defaultdict(set)   # repo/sha -> the sessions it was observed in
for u, cs in per_unit.items():
    seen, graded = set(), []
    for rp, sh, ts in cs:
        if (rp, sh) in seen or rp not in H:
            continue
        seen.add((rp, sh))
        if closed(rp, sh):
            graded.append((w_out(rp, sh, p7w), ts, f'{rp}/{sh}'))
    if not graded:
        continue
    units_any.append([u, 1 if any(o for o, _, _ in graded) else 0])
    for o, ts, key in graded:
        commits.append([u, ts, o, key])
        keys[key].add(u.split('\x00')[0])

# Cross-session repeats are the one way a commit-level analysis can count the same commit twice
# under two clusters. Measured rather than assumed away, because it sets the size of the error.
cross = {k: sorted(v) for k, v in keys.items() if len(v) > 1}

json.dump(dict(commits=commits, units_any=units_any), open(out_path, 'w'))

commit_days = len({ts[:10] for _, ts, _, _ in commits})
unit_days = len({u.split('\x00')[0] for u, _ in units_any})
print(json.dumps(dict(
    units=len(units_any),
    units_any_rate=round(sum(o for _, o in units_any) / len(units_any), 5),
    commit_observations=len(commits),
    distinct_commits=len(keys),
    commit_rate=round(sum(o for _, _, o, _ in commits) / len(commits), 5),
    commit_active_days=commit_days,
    sessions=unit_days,
    commits_per_unit=round(len(commits) / len(units_any), 2),
    cross_session_commits=len(cross),
), indent=1))
