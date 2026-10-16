# asc-09wx.12 scoping (throwaway): what actually has to be traced, per axis.
#
# A commit C is graded `reworked_7` from the pair set p7, which blame.py builds from the REWRITER:
# tracing R yields (intro, f) for every earlier commit whose line R rewrote. So to grade C you must
# trace the commits in (t_C, t_C+7d] of C's repo -- C itself need not be traced. The trace set is
# that closure, restricted to commits that can hold a source line (a `no source` commit can never
# rewrite a source line, so it is free to skip).
#
# Read-only. Usage: python3 -I split3.py <join.jsonl> <ev63-dir> <cost-dir> <out.json>
import bisect, collections, datetime, json, re, subprocess as _sp, sys

join_path, ev63, costdir, out_path = sys.argv[1:5]
DAY = 86400
NOW = 1792080000
ACTIVE_DAYS = 48
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)
TRACED = ('ascend', 'grizzly-pl', 'mast', 'spindle')
UNTRACED = ('grizzly-exp', 'grizzly-sv', 'grizzly-wip', 'grizzly-platform')

def load_numstat(path):
    commits = {}
    for rec in open(path, encoding='utf-8', errors='replace').read().split('\x1e')[1:]:
        p = rec.split('\x1f')
        if len(p) < 4:
            continue
        lines = [l.split('\t') for l in p[3].strip().split('\n') if l.count('\t') == 2]
        files = [(f[2], int(f[0])) for f in lines if f[0].isdigit()]
        commits[p[0]] = dict(at=int(p[1]), files=files, n_files=len(lines))
    return commits

H = {n: load_numstat(f'{ev63}/{n}/numstat.log') for n in TRACED}
for n in UNTRACED:
    H[n] = load_numstat(f'{costdir}/{n}.numstat.log')

def load_extra():
    """The commits the join names that postdate the ev63 numstat snapshot (git show, read-only)."""
    got = {}
    for rec in open(f'{costdir}/extra.numstat.log', encoding='utf-8', errors='replace').read().split('\x1e')[1:]:
        p = rec.split('\x1f')
        if len(p) < 4:
            continue
        lines = [l.split('\t') for l in p[3].strip().split('\n') if l.count('\t') == 2]
        files = [(f[2], int(f[0])) for f in lines if f[0].isdigit()]
        got[p[0]] = dict(at=int(p[1]), files=files, n_files=len(lines))
    return got

EXTRA = load_extra()
# which extra sha belongs to which traced repo (a sha is unique across the clones except the
# shared root commit, which is not one of these)
PATHS = {'ascend': '/Users/spikedpunchvictim/projects/ascend',
         'grizzly-pl': '/Users/spikedpunchvictim/projects/grizzly/grizzly-pl',
         'mast': '/Users/spikedpunchvictim/projects/mast',
         'spindle': '/Users/spikedpunchvictim/projects/spindle'}
_owner = {}
for n in TRACED:
    for s in EXTRA:
        if s in H[n] or s in _owner:
            continue
        if _sp.run(['git', '-C', PATHS[n], 'cat-file', '-e', s + '^{commit}'],
                   capture_output=True).returncode == 0:
            _owner[s] = n
for s, n in _owner.items():
    H[n][s] = EXTRA[s]

LAST = {n: max(c['at'] for c in cs.values()) for n, cs in H.items()}
BYTIME = {n: sorted((c['at'], s) for s, c in cs.items()) for n, cs in H.items()}
TIMES = {n: [t for t, _ in v] for n, v in BYTIME.items()}
# what the tracer was actually fed: ev63's list.tsv
FED = {}
for n in TRACED:
    FED[n] = {l.split('\t')[0] for l in open(f'{ev63}/{n}/list.tsv')}
for n in UNTRACED:
    FED[n] = set()          # never traced

def has_src(n, s):
    c = H[n].get(s)
    if c is None:
        return False
    return any(a > 0 and not NOT_SOURCE.search(f) for f, a in c['files'])

def closure(seeds):
    got = set()
    for rp, sh in seeds:
        c = H[rp].get(sh)
        if c is None:
            continue
        i = bisect.bisect_right(TIMES[rp], c['at'])
        j = bisect.bisect_right(TIMES[rp], c['at'] + 7 * DAY)
        for _, s in BYTIME[rp][i:j]:
            got.add((rp, s))
    return got

rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.defaultdict(list)
for r in rows:
    if r['sha'] and r['repo'] and r['repo'] in H:
        per_unit[r['unit']].append((r['repo'], r['sha']))
all_units = {r['unit'] for r in rows}

def elig(n, s):
    c = H[n].get(s)
    if c is None:
        return False
    return has_src(n, s) and c['n_files'] <= 30 and c['at'] <= LAST[n] - 7 * DAY

def best_traced(cs):
    ks = []
    for rp, sh in cs:
        if rp not in TRACED:
            continue
        c = H[rp].get(sh)
        ks.append('x_newer_than_snapshot' if c is None else
                  'a_no_source' if not has_src(rp, sh) else
                  'b_over30' if c['n_files'] > 30 else
                  'd_recent' if c['at'] > LAST[rp] - 7 * DAY else 'ok')
    for k in ('ok', 'x_newer_than_snapshot', 'd_recent', 'b_over30', 'a_no_source'):
        if k in ks:
            return k
    return 'no_traced_commit'

def best_untraced(cs):
    ks = []
    for rp, sh in cs:
        if rp not in UNTRACED:
            continue
        c = H[rp].get(sh)
        ks.append('x_absent' if c is None else
                  'a_no_source' if not has_src(rp, sh) else
                  'b_over30' if c['n_files'] > 30 else
                  'd_recent' if c['at'] > LAST[rp] - 7 * DAY else 'ok')
    for k in ('ok', 'x_absent', 'd_recent', 'b_over30', 'a_no_source'):
        if k in ks:
            return k
    return 'no_untraced_commit'

traced_split = collections.Counter(best_traced(cs) for cs in per_unit.values())
untraced_split = collections.Counter(best_untraced(cs) for cs in per_unit.values())

def units(pred):
    return {u for u, cs in per_unit.items() if pred(cs)}

today = units(lambda cs: any(rp in TRACED and elig(rp, sh) for rp, sh in cs))
A = units(lambda cs: any(rp in TRACED and has_src(rp, sh) for rp, sh in cs))
B = units(lambda cs: any(rp in UNTRACED and has_src(rp, sh) for rp, sh in cs))
C = A | B
# of the d_recent on the traced side, which are only "recent" because the repo stopped (window shut)?
def shut(n, s):
    return H[n][s]['at'] + 7 * DAY <= NOW

seeds_A = {(rp, sh) for u, cs in per_unit.items() for rp, sh in cs if rp in TRACED}
seeds_B = {(rp, sh) for u, cs in per_unit.items() for rp, sh in cs if rp in UNTRACED}
clA, clB = closure(seeds_A), closure(seeds_B)

def cost(named, cl):
    src = {(rp, s) for rp, s in cl if has_src(rp, s)}
    notfed = {(rp, s) for rp, s in src if s not in FED[rp]}
    over30 = {(rp, s) for rp, s in notfed if H[rp][s]['n_files'] > 30}
    return dict(closure=len(cl), source_bearing=len(src), to_trace=len(notfed),
                to_trace_over30=len(over30), to_trace_otherwise=len(notfed) - len(over30))

out = dict(
    units=dict(total=len(all_units), with_commit=len(per_unit),
               today=len(today), axisA=len(A), axisB=len(B), axisC=len(C),
               axisB_only=len(B - A), ceiling=len(C),
               unrecoverable_no_source=len(per_unit) - len(C),
               unrecoverable_no_commit=len(all_units) - len(per_unit)),
    rates={k: round(v / ACTIVE_DAYS, 3) for k, v in
           dict(today=len(today), axisA=len(A), axisB=len(B), axisC=len(C)).items()},
    traced_split=dict(traced_split), untraced_split=dict(untraced_split),
    # traced-side d_recent whose own 7-day window has already shut by now
    shut_recent=len(units(lambda cs: best_traced(cs) == 'd_recent' and
                          all(rp not in TRACED or shut(rp, sh) for rp, sh in cs))),
    tracesets=dict(axisA=cost(seeds_A, clA), axisB=cost(seeds_B, clB),
                   axisC=cost(seeds_A | seeds_B, clA | clB)),
)
json.dump(out, open(out_path, 'w'), indent=1)
print('UNITS', json.dumps(out['units']))
print('RATES/day', json.dumps(out['rates']))
print('traced-side split  ', json.dumps(out['traced_split']))
print('untraced-side split', json.dumps(out['untraced_split']))
print('shut_recent (window already closed, graded free):', out['shut_recent'])
print('TRACE SETS')
for k, v in out['tracesets'].items():
    print(f"   {k}: {json.dumps(v)}")
