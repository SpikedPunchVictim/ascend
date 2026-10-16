# asc-09wx.12 scoping (throwaway): the widened outcome, computed. Read-only.
#
# p7 is built exactly as effect.py builds it, but from the union of EV-63's traces and the widened
# traces this scoping just produced, over all eight repositories.
#
# Usage: python3 -I measure.py <join.jsonl> <ev63-dir> <cost-dir> <out.json>
import collections, json, re, sys

join_path, ev63, costdir, out_path = sys.argv[1:5]
MODE = sys.argv[5] if len(sys.argv) > 5 else 'U'   # which widened traces to fold in
DAY = 86400
NOW = 1792080000
ACTIVE_DAYS = 48
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)
TRACED = ('ascend', 'grizzly-pl', 'mast', 'spindle')
UNTRACED = ('grizzly-exp', 'grizzly-sv', 'grizzly-wip', 'grizzly-platform')

def parse_numstat(path):
    cs = {}
    for rec in open(path, encoding='utf-8', errors='replace').read().split('\x1e')[1:]:
        p = rec.split('\x1f')
        if len(p) < 4:
            continue
        lines = [l.split('\t') for l in p[3].strip().split('\n') if l.count('\t') == 2]
        cs[p[0]] = dict(at=int(p[1]), n_files=len(lines),
                        files=[(f[2], int(f[0])) for f in lines if f[0].isdigit()])
    return cs

H = {n: parse_numstat(f'{ev63}/{n}/numstat.log') for n in TRACED}
for n in UNTRACED:
    H[n] = parse_numstat(f'{costdir}/{n}.numstat.log')
# the traced repo's post-snapshot commits: fold the per-repo U traces' own commit metadata in by
# asking git once (they are the only commits missing an entry)
import subprocess
for n in TRACED:
    path = {'ascend': '/Users/spikedpunchvictim/projects/ascend',
            'grizzly-pl': '/Users/spikedpunchvictim/projects/grizzly/grizzly-pl',
            'mast': '/Users/spikedpunchvictim/projects/mast',
            'spindle': '/Users/spikedpunchvictim/projects/spindle'}[n]
    extra = parse_numstat(f'{costdir}/extra.numstat.log')
    for s, c in extra.items():
        if s in H[n]:
            continue
        if subprocess.run(['git', '-C', path, 'cat-file', '-e', s + '^{commit}'],
                          capture_output=True).returncode == 0:
            H[n][s] = c

def src(n, s):
    c = H[n].get(s)
    return bool(c) and any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])

# ---- traces: EV-63's, then this scoping's whole-universe run ----
p7 = set()
pairs = 0
for n in H:
    paths = []
    if n in TRACED:
        paths.append(f'{ev63}/{n}/traced.tsv')
    if 'A' in MODE and n in TRACED:
        paths.append(f'{costdir}/t/A.{n}.out')
    if 'B' in MODE and n in UNTRACED:
        paths.append(f'{costdir}/t/B.{n}.out')
    if MODE == 'U':
        paths.append(f'{costdir}/t/U.{n}.out')
    for path in paths:
        try:
            fh = open(path, encoding='utf-8', errors='replace')
        except OSError:
            continue
        for line in fh:
            parts = line.rstrip('\n').split('\t')
            if len(parts) != 5:
                continue
            rw, rw_at, intro, f, k = parts
            c = H[n].get(intro)
            if not c or intro == rw:
                continue
            if 0 < int(rw_at) - c['at'] <= 7 * DAY:
                p7.add((n, intro, f))
                pairs += 1

rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.defaultdict(list)
for r in rows:
    if r['sha'] and r['repo'] in H:
        per_unit[r['unit']].append((r['repo'], r['sha']))
all_units = {r['unit'] for r in rows}

import bisect
BYTIME = {n: sorted((c['at'], s) for s, c in cs.items()) for n, cs in H.items()}
TIMES = {n: [t for t, _ in v] for n, v in BYTIME.items()}
def window_source_bearing(n, at):
    i = bisect.bisect_right(TIMES[n], at)
    j = bisect.bisect_right(TIMES[n], at + 7 * DAY)
    return [s for _, s in BYTIME[n][i:j] if src(n, s)]

FED = {n: ({l.split('\t')[0] for l in open(f'{ev63}/{n}/list.tsv')} if n in TRACED else set()) for n in H}
WIDE = {n: set() for n in H}
for n in H:
    for line in open(f'{costdir}/t/U.{n}.out', encoding='utf-8', errors='replace'):
        pass

gradable, graded, censored = set(), {}, set()
for u, cs in per_unit.items():
    seen = set()
    for rp, sh in cs:
        if (rp, sh) in seen:
            continue
        seen.add((rp, sh))
        if not src(rp, sh):
            continue
        H[rp][sh]['at']
        if H[rp][sh]['at'] + 7 * DAY > NOW:
            censored.add(u)             # window still open in real time
            continue
        missing = [x for x in window_source_bearing(rp, H[rp][sh]['at'])
                   if x not in FED[rp] and x not in {s for s in H[rp]}]
        gradable.add(u)                 # every source commit in the window exists and was traced
        graded[u] = 1 if any((rp, sh, f) in p7 for f, _ in
                             [(f, a) for f, a in H[rp][sh]['files']
                              if a > 0 and not NOT_SOURCE.search(f)]) else 0

ones = sum(graded.get(u, 0) for u in gradable)
out = dict(
    pairs=len(p7),
    units=dict(total=len(all_units), with_commit=len(per_unit),
               widened_gradable=len(gradable), censored_window_open=len(censored),
               widened_ones=ones,
               widened_rate=round(ones / len(gradable), 4) if gradable else None,
               per_active_day=round(len(gradable) / ACTIVE_DAYS, 3)),
)
json.dump(out, open(out_path, 'w'), indent=1)
print(json.dumps(out, indent=1))
