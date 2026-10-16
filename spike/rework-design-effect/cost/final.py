# asc-09wx.12 scoping (throwaway): the final table -- per-axis unit counts by why-not, and the
# cross-clone duplicate work. Read-only. Usage: python3 -I final.py <join.jsonl> <ev63> <cost>
import bisect, collections, json, re, subprocess, sys

join_path, ev63, costdir = sys.argv[1:4]
DAY, NOW, ACTIVE_DAYS = 86400, 1792080000, 48
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
EXTRA = parse(f'{costdir}/extra.numstat.log')
for s, c in EXTRA.items():
    for n in TRACED:
        if s in H[n] or not subprocess.run(['git', '-C', PATHS[n], 'cat-file', '-e', s + '^{commit}'],
                                           capture_output=True).returncode == 0:
            continue
        H[n][s] = c
        break

def src(n, s):
    c = H[n].get(s)
    return bool(c) and any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])

def shut(n, s):
    return H[n][s]['at'] + 7 * DAY <= NOW

rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.defaultdict(list)
for r in rows:
    if r['sha'] and r['repo'] in H:
        per_unit[r['unit']].append((r['repo'], r['sha']))
all_units = {r['unit'] for r in rows}

def axis(names):
    a = {}
    for label, pred in (('source_window_closed', lambda rp, sh: shut(rp, sh)),
                        ('source_window_open', lambda rp, sh: not shut(rp, sh))):
        a[label] = {u for u, cs in per_unit.items()
                    if any(rp in names and src(rp, sh) and pred(rp, sh) for rp, sh in cs)}
    a['no_source_only'] = {u for u, cs in per_unit.items()
                           if any(rp in names for rp, _ in cs)
                           and not any(rp in names and src(rp, sh) for rp, sh in cs)}
    return a

A, B = axis(set(TRACED)), axis(set(UNTRACED))
Csrc = {u for u, cs in per_unit.items() if any(src(rp, sh) for rp, sh in cs)}
Cclosed = {u for u, cs in per_unit.items() if any(src(rp, sh) and shut(rp, sh) for rp, sh in cs)}

# ---- cross-clone duplicate work ----
overlap = {}
sha_sets = {n: {s for s in H[n] if s != 'e3f800b95266c7b321bb803c96ceff939e25af9f'} for n in UNTRACED}
for n in UNTRACED:
    sha_sets[n] = {s for s in sha_sets[n] if src(n, s)}
shared = collections.Counter()
for n in UNTRACED:
    for m in UNTRACED:
        if n < m:
            shared[f'{n}&{m}'] = len(sha_sets[n] & sha_sets[m])
uA = set()
for n in UNTRACED:
    uA |= sha_sets[n]
overlap = dict(pairwise=shared, union=len(uA), sum=sum(len(v) for v in sha_sets.values()),
               shared_any=sum(v - 1 for v in collections.Counter(
                   s for n in UNTRACED for s in sha_sets[n]).values() if v > 1))

out = dict(
    today_ev63=104, today_ev63_per_day=round(104 / ACTIVE_DAYS, 3),
    axes={k: {kk: len(vv) for kk, vv in v.items()} for k, v in (('A', A), ('B', B))},
    C=dict(source_any=len(Csrc), source_window_closed=len(Cclosed),
           per_day_closed=round(len(Cclosed) / ACTIVE_DAYS, 3),
           per_day_ceiling=round(len(Csrc) / ACTIVE_DAYS, 3)),
    ungradable=dict(no_source_only=len(per_unit) - len(Csrc),
                    no_commit_at_all=len(all_units) - len(per_unit),
                    total=len(all_units) - len(Cclosed)),
    clone_overlap=overlap,
)
print(json.dumps(out, indent=1))
