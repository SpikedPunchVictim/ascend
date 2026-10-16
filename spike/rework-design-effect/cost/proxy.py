# asc-09wx.12 scoping (throwaway): how faithful is a blame-free proxy outcome?
#
# proxy(C) = some commit within 7 days of C touches a file in C's source set (from numstat only).
# Compare it with the traced `reworked_7` on every unit where both exist. Read-only.
#
# Usage: python3 -I proxy.py <join.jsonl> <ev63> <cost>
import bisect, collections, json, re, subprocess, sys

join_path, ev63, costdir = sys.argv[1:4]
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

def src(n, s):
    c = H[n].get(s)
    return bool(c) and any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])

BYTIME = {n: sorted((c['at'], s) for s, c in cs.items()) for n, cs in H.items()}
TIMES = {n: [t for t, _ in v] for n, v in BYTIME.items()}
# file -> sorted commit times, per repo
TOUCH = {}
for n, cs in H.items():
    d = collections.defaultdict(list)
    for s, c in cs.items():
        for f, _ in c['files']:
            d[f].append(c['at'])
    for v in d.values():
        v.sort()
    TOUCH[n] = d

def proxy(n, s):
    """Some commit in (t_C, t_C+7d] touches a file C's source set names."""
    c = H[n].get(s)
    if not c:
        return None
    for f, a in c['files']:
        if a <= 0 or NOT_SOURCE.search(f):
            continue
        v = TOUCH[n][f]
        i = bisect.bisect_right(v, c['at'])
        if i < len(v) and v[i] <= c['at'] + 7 * DAY:
            return 1
    return 0

# traced outcome, exactly as measure.py: union of EV-63's traces and this scoping's whole-universe run
p7 = set()
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
            rw, rw_at, intro, f, k = q
            c = H[n].get(intro)
            if c and intro != rw and 0 < int(rw_at) - c['at'] <= 7 * DAY:
                p7.add((n, intro, f))

rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.defaultdict(set)
for r in rows:
    if r['sha'] and r['repo'] in H:
        per_unit[r['unit']].add((r['repo'], r['sha']))

exact, prox = {}, {}
for u, cs in per_unit.items():
    for rp, sh in cs:
        if not src(rp, sh) or H[rp][sh]['at'] + 7 * DAY > NOW:
            continue
        exact[u] = 1 if any((rp, sh, f) in p7 for f, a in H[rp][sh]['files']
                            if a > 0 and not NOT_SOURCE.search(f)) else 0
        prox[u] = proxy(rp, sh)
        break

ks = sorted(exact)
n = len(ks)
a = sum(exact[k] and prox[k] for k in ks)      # both 1
b = sum(exact[k] and not prox[k] for k in ks)  # exact 1, proxy 0
c = sum(not exact[k] and prox[k] for k in ks)
d = n - a - b - c
pe = ((a + b) * (a + c) + (c + d) * (b + d)) / n ** 2
out = dict(n=n, exact_rate=round((a + b) / n, 4), proxy_rate=round((a + c) / n, 4),
           both=a, exact_only=b, proxy_only=c, neither=d,
           sensitivity=round(a / (a + b), 4) if a + b else None,
           precision=round(a / (a + c), 4) if a + c else None,
           kappa=round(((a + d) / n - pe) / (1 - pe), 4) if pe < 1 else None)
print(json.dumps(out, indent=1))
