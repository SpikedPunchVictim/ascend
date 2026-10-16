# asc-09wx.12 / asc-lspj: per-unit outcomes for the design effect, narrow and widened.
#
# Emits the shape spike/rework-design-effect/design.mjs reads: {outcomes: {rule: [[unit, outcome]]}}.
# Read-only. Usage: python3 -I rho.py <join.jsonl> <ev63> <cost> <outdir>
import bisect, collections, json, re, subprocess, sys

join_path, ev63, costdir, outdir = sys.argv[1:5]
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

# ---------------- the NARROW corpus, exactly as effect.py loads it ----------------
N = {n: parse(f'{ev63}/{n}/numstat.log') for n in TRACED}
NLAST = {n: max(c['at'] for c in cs.values()) for n, cs in N.items()}
def n_src(n, s):
    c = N[n].get(s)
    return bool(c) and any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])
def n_elig(n, s):
    c = N[n].get(s)
    return bool(c) and n_src(n, s) and c['n_files'] <= 30 and c['at'] <= NLAST[n] - 7 * DAY
p7n = set()
for n in TRACED:
    for line in open(f'{ev63}/{n}/traced.tsv'):
        q = line.rstrip('\n').split('\t')
        if len(q) != 5:
            continue
        rw, rw_at, intro, f, _ = q
        c = N[n].get(intro)
        if c and intro != rw and 0 < int(rw_at) - c['at'] <= 7 * DAY:
            p7n.add((n, intro, f))
def n_out(n, s, p7):
    c = N[n][s]
    return 1 if any((n, s, f) in p7 for f, a in c['files'] if a > 0 and not NOT_SOURCE.search(f)) else 0

# ---------------- the WIDENED corpus ----------------
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

# ---------------- per-unit, in trigger order ----------------
rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.OrderedDict()
for r in rows:
    if r['sha'] and r['repo'] in H:
        per_unit.setdefault(r['unit'], []).append((r['repo'], r['sha'], r['route']))

def build(pick, outcome_of, impute=None):
    """pick(repo,sha) -> True when this commit carries an outcome for the unit."""
    res = {r: [] for r in ('first', 'last', 'any', 'all', 'first_sha', 'any_sha')}
    censored = []
    for u, cs in per_unit.items():
        seen, graded = set(), []
        for rp, sh, route in cs:
            if (rp, sh) in seen or rp not in H:
                continue
            seen.add((rp, sh))
            if pick(rp, sh):
                graded.append((outcome_of(rp, sh), route))
        if not graded:
            censored.append(u)
            continue
        base = dict(first=graded[0][0], last=graded[-1][0],
                    any=1 if any(o for o, _ in graded) else 0,
                    all=1 if all(o for o, _ in graded) else 0)
        for rul in ('first', 'last', 'any', 'all'):
            res[rul].append([u, base[rul]])
        for rul in ('first_sha', 'any_sha'):
            sh = [o for o, rt in graded if rt == 'sha']
            if sh:
                res[rul].append([u, sh[0] if rul == 'first_sha' else (1 if any(sh) else 0)])
    if impute is not None:
        for u in censored:
            v = impute(u)
            if v is None:
                continue                      # not a unit this population covers -- leave it out
            for rul in res:
                res[rul].append([u, v])
    return res, censored

# ---- NARROW: the population effect.py/design.mjs measured (expect n=104, rate 0.5288 under first)
narrow, ncens = build(lambda rp, sh: rp in TRACED and n_elig(rp, sh),
                      lambda rp, sh: n_out(rp, sh, p7n))
json.dump(dict(outcomes=narrow), open(f'{outdir}/rho-narrow.json', 'w'), indent=1)

# ---- WIDENED, window-closed: the computable population
now, cens = build(lambda rp, sh: w_src(rp, sh) and H[rp][sh]['at'] + 7 * DAY <= NOW,
                  lambda rp, sh: w_out(rp, sh, p7w))
json.dump(dict(outcomes=now), open(f'{outdir}/rho-wide-now.json', 'w'), indent=1)
# ---- WIDENED, source-bearing: the ceiling -- the censored units have NO closed window
ceil_open = {u for u, cs in per_unit.items()
             if any(w_src(rp, sh) for rp, sh, _ in cs) and u in set(cens)}
print(json.dumps(dict(
    narrow_first_n=len(narrow['first']), narrow_censored=len(ncens),
    wide_now_first_n=len(now['first']), wide_now_censored=len(cens),
    wide_ceiling_first_n=len(now['first']) + len(ceil_open),
    ceiling_censored=len(ceil_open),
    wide_now_any_rate=round(sum(o for _, o in now['any']) / len(now['any']), 4),
    wide_now_all_rate=round(sum(o for _, o in now['all']) / len(now['all']), 4))))
# the ceiling population under two labelled imputations of the censored units. ONLY the 95 that
# have a source-bearing commit but no closed window are imputed; the other 125 censored units have
# no source line at all and are not part of this population.
for tag, v in (('zero', 0), ('one', 1)):
    c2, _ = build(lambda rp, sh: w_src(rp, sh) and H[rp][sh]['at'] + 7 * DAY <= NOW,
                  lambda rp, sh: w_out(rp, sh, p7w),
                  impute=lambda u, v=v: v if u in ceil_open else None)
    json.dump(dict(outcomes=c2), open(f'{outdir}/rho-wide-ceiling-{tag}.json', 'w'), indent=1)

# a third imputation that at least respects the cluster structure: each censored unit takes the
# MAJORITY observed outcome of the units in its own session. Still an imputation, not a measurement.
sess = lambda u: u.split('\x00')[0]
seen_rate = collections.defaultdict(list)
for u, o in now['first']:
    seen_rate[sess(u)].append(o)
major = {s: (1 if sum(v) * 2 > len(v) else 0) for s, v in seen_rate.items()}
c3, _ = build(lambda rp, sh: w_src(rp, sh) and H[rp][sh]['at'] + 7 * DAY <= NOW,
              lambda rp, sh: w_out(rp, sh, p7w),
              impute=lambda u: major.get(sess(u), 0) if u in ceil_open else None)
json.dump(dict(outcomes=c3), open(f'{outdir}/rho-wide-ceiling-neighbour.json', 'w'), indent=1)
print(json.dumps(dict(neighbour_majority=major, imputed=len(ceil_open),
                      imputed_ones=sum(1 for u in ceil_open if major.get(sess(u), 0)))))
