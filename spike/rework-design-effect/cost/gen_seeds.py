# asc-09wx.12 scoping (throwaway): emit the exact per-repo trace lists for each widening axis.
# Read-only. Usage: python3 -I gen_seeds.py <join.jsonl> <ev63-dir> <cost-dir>
import bisect, collections, json, re, subprocess, sys

join_path, ev63, costdir = sys.argv[1:4]
DAY = 86400
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)
TRACED = ('ascend', 'grizzly-pl', 'mast', 'spindle')
UNTRACED = ('grizzly-exp', 'grizzly-sv', 'grizzly-wip', 'grizzly-platform')
PATHS = {'ascend': '/Users/spikedpunchvictim/projects/ascend',
         'grizzly-pl': '/Users/spikedpunchvictim/projects/grizzly/grizzly-pl',
         'mast': '/Users/spikedpunchvictim/projects/mast',
         'spindle': '/Users/spikedpunchvictim/projects/spindle'}
for n in UNTRACED:
    PATHS[n] = f'/Users/spikedpunchvictim/projects/grizzly/{n}'

def parse(raw):
    cs = {}
    for rec in raw.split('\x1e')[1:]:
        p = rec.split('\x1f')
        if len(p) < 4:
            continue
        lines = [l.split('\t') for l in p[3].strip().split('\n') if l.count('\t') == 2]
        cs[p[0]] = dict(at=int(p[1]), n_files=len(lines),
                        files=[(f[2], int(f[0])) for f in lines if f[0].isdigit()])
    return cs

H = {}
for n in TRACED:
    H[n] = parse(open(f'{ev63}/{n}/numstat.log', encoding='utf-8', errors='replace').read())
for n in UNTRACED:
    H[n] = parse(open(f'{costdir}/{n}.numstat.log', encoding='utf-8', errors='replace').read())
EXTRA = parse(open(f'{costdir}/extra.numstat.log', encoding='utf-8', errors='replace').read())
owner = {}
for n in TRACED:
    for s in EXTRA:
        if s in H[n] or s in owner:
            continue
        if subprocess.run(['git', '-C', PATHS[n], 'cat-file', '-e', s + '^{commit}'],
                          capture_output=True).returncode == 0:
            owner[s] = n
for s, n in owner.items():
    H[n][s] = EXTRA[s]

BYTIME = {n: sorted((c['at'], s) for s, c in cs.items()) for n, cs in H.items()}
TIMES = {n: [t for t, _ in v] for n, v in BYTIME.items()}
FED = {n: ({l.split('\t')[0] for l in open(f'{ev63}/{n}/list.tsv')} if n in TRACED else set()) for n in H}

def src(n, s):
    c = H[n].get(s)
    return bool(c) and any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])

rows = [json.loads(l) for l in open(join_path)]
seeds = collections.defaultdict(set)
for r in rows:
    if r['sha'] and r['repo'] in H:
        seeds[r['repo']].add(r['sha'])

def closure_of(names):
    out = collections.defaultdict(set)
    for n in names:
        for s in seeds[n]:
            c = H[n].get(s)
            if not c:
                continue
            i = bisect.bisect_right(TIMES[n], c['at'])
            j = bisect.bisect_right(TIMES[n], c['at'] + 7 * DAY)
            for _, x in BYTIME[n][i:j]:
                out[n].add(x)
    return out

def write(tag, cl, only_unfed):
    total = 0
    for n, ss in cl.items():
        sel = [s for s in ss if src(n, s) and (s not in FED[n] if only_unfed else True)]
        # blame needs <sha>^ ; the root commit of the shared grizzly history has none
        sel = [s for s in sel if subprocess.run(['git', '-C', PATHS[n], 'rev-parse', '-q', '--verify',
                                                 s + '^'], capture_output=True).returncode == 0]
        open(f'{costdir}/t/{tag}.{n}.tsv', 'w').write(
            '\n'.join(f'{s}\t{H[n][s]["at"]}' for s in sel) + ('\n' if sel else ''))
        total += len(sel)
        print(f'  {tag} {n:16s} {len(sel)}')
    return total

print('AXIS A (four traced repos, filter dropped):')
a = closure_of(TRACED)
nA = write('A', a, True)
print('AXIS B (four untraced clones, traced from scratch):')
b = closure_of(UNTRACED)
nB = write('B', b, False)
print('WHOLE UNIVERSE (every commit of all eight repos):')
u = {n: set(H[n]) for n in H}
nU = write('U', u, True)
print(json.dumps(dict(axisA=nA, axisB=nB, universe=nU, universe_traced=sum(len(s) for n, s in u.items() if n in TRACED))))
