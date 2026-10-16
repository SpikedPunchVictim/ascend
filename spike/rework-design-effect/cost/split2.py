# asc-09wx.12 scoping (throwaway): the (a)/(b) split per widening axis, and the ceiling.
#
# Read-only. Usage: python3 -I split2.py <join.jsonl> <ev63-dir> <cost-dir> <out.json>
import bisect, collections, datetime, json, re, sys

join_path, ev63, costdir, out_path = sys.argv[1:5]
DAY = 86400
NOW = 1792080000          # 2026-10-15T08:00Z, ~the corpus's last day
ACTIVE_DAYS = 48          # asc-09wx.12's own denominator (2026-08-25 .. 2026-10-15)
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

hist = {n: load_numstat(f'{ev63}/{n}/numstat.log') for n in TRACED}
for n in UNTRACED:
    hist[n] = load_numstat(f'{costdir}/{n}.numstat.log')
# every commit timestamp, for the 7-day-window closure
bytime = {n: sorted((c['at'], s) for s, c in cs.items()) for n, cs in hist.items()}
times = {n: [t for t, _ in v] for n, v in bytime.items()}

def window(repo, at):
    """Every commit of `repo` in (at, at+7d] -- what must be traced to observe `at`'s rework."""
    i = bisect.bisect_right(times[repo], at)
    j = bisect.bisect_right(times[repo], at + 7 * DAY)
    return [s for _, s in bytime[repo][i:j]]

def kind(repo, sha):
    c = hist.get(repo, {}).get(sha)
    if c is None:
        return 'x_unknown'                     # exists in the repo (verified), newer than the snapshot
    src = [(f, a) for f, a in c['files'] if a > 0 and not NOT_SOURCE.search(f)]
    if not src:
        return 'a_no_source'                   # (a): unrecoverable at any price
    if c['n_files'] > 30:
        return 'b_over30'                      # (b): file cap
    if c['at'] > NOW - 7 * DAY:
        return 'c_recent'                      # pending: window not yet closed, zero compute
    return 'ok_eligible'

SOURCEY = ('ok_eligible', 'b_over30', 'c_recent', 'x_unknown')
ORDER = ['ok_eligible', 'c_recent', 'b_over30', 'x_unknown', 'a_no_source']

rows = [json.loads(l) for l in open(join_path)]
per_unit = collections.defaultdict(list)
for r in rows:
    if r['sha'] and r['repo']:
        per_unit[r['unit']].append((r['repo'], r['sha']))
all_units = {r['unit'] for r in rows}

def best(cs):
    ks = {kind(rp, sh) for rp, sh in cs}
    for k in ORDER:
        if k in ks:
            return k
    return 'no_commit'

tab = collections.Counter()
for u, cs in per_unit.items():
    t = best([(rp, sh) for rp, sh in cs if rp in TRACED]) if any(rp in TRACED for rp, _ in cs) else 'no_commit'
    n = best([(rp, sh) for rp, sh in cs if rp in UNTRACED]) if any(rp in UNTRACED for rp, _ in cs) else 'no_commit'
    tab[(t, n)] += 1

# ---- the trace sets ----
def named(names):
    got = set()
    for u, cs in per_unit.items():
        for rp, sh in cs:
            if rp in names:
                got.add((rp, sh))
    return got

def closure(seeds):
    got = set()
    for rp, sh in seeds:
        c = hist[rp].get(sh)
        if c is None:
            continue
        got.add((rp, sh))
        for s in window(rp, c['at']):
            got.add((rp, s))
    return got

def summarise(seed_set):
    got = closure(seed_set)
    kinds = collections.Counter(kind(rp, sh) for rp, sh in got)
    return dict(seeds=len(seed_set), closure=len(got), **{k: kinds[k] for k in ORDER})

# ---- per-axis unit outcome ----
def units_with(pred):
    return {u for u, cs in per_unit.items() if pred(cs)}

A_today = units_with(lambda cs: best([(rp, sh) for rp, sh in cs if rp in TRACED]) == 'ok_eligible')
A_ceil = units_with(lambda cs: any(rp in TRACED and kind(rp, sh) in SOURCEY for rp, sh in cs))
A_over30 = units_with(lambda cs: best([(rp, sh) for rp, sh in cs if rp in TRACED]) == 'b_over30')
B_ceil = units_with(lambda cs: any(rp in UNTRACED and kind(rp, sh) in SOURCEY for rp, sh in cs))
C_ceil = A_ceil | B_ceil
any_src = units_with(lambda cs: any(kind(rp, sh) in SOURCEY for rp, sh in cs))
any_commit = set(per_unit)
pending = units_with(lambda cs: best([(rp, sh) for rp, sh in cs if rp in TRACED]) == 'c_recent')

out = dict(
    units=dict(today=len(A_today), axisA=len(A_ceil), axisA_over30_only=len(A_over30),
               axisB=len(B_ceil), axisC=len(C_ceil), absolute_ceiling=len(any_src),
               any_commit=len(any_commit), total=len(all_units), pending_recent=len(pending),
               axisB_marginal=len(B_ceil - A_today), axisC_marginal=len(C_ceil - A_today)),
    rates={k: round(v / ACTIVE_DAYS, 2) for k, v in dict(
        today=len(A_today), axisA=len(A_ceil), axisB=len(B_ceil), axisC=len(C_ceil),
        absolute_ceiling=len(any_src), any_commit=len(any_commit), total=len(all_units)).items()},
    trace_sets=dict(
        axisA_named=summarise(named(TRACED)),
        axisA_over30_only=summarise({(rp, sh) for rp, sh in named(TRACED) if kind(rp, sh) in ('b_over30', 'x_unknown')}),
        axisB_named=summarise(named(UNTRACED)),
        axisC_named=summarise(named(TRACED) | named(UNTRACED)),
        whole_traced_universe=summarise({(n, s) for n in TRACED for s in hist[n]}),
        whole_untraced_universe=summarise({(n, s) for n in UNTRACED for s in hist[n]})),
    table={'%s|%s' % k: v for k, v in sorted(tab.items())},
    units_by_kind={k: sum(v for kk, v in tab.items() if k in kk) for k in ORDER},
)
json.dump(out, open(out_path, 'w'), indent=1)

print('=== UNIT COUNTS ===')
print(json.dumps(out['units']))
print('=== RATES per active day (48) ===')
print(json.dumps(out['rates']))
print('=== units x untraced-best (rows) x traced-best (cols) ===')
cols = ORDER + ['no_commit']
print('traced\\untraced'.ljust(18), ' '.join(c[:9].rjust(9) for c in cols))
for t in cols:
    print(t.ljust(18), ' '.join(str(tab[(t, n)]).rjust(9) for n in cols))
print('=== TRACE SETS (seeds -> 7-day closure, split by kind) ===')
for k, v in out['trace_sets'].items():
    print(f"   {k:26s} seeds={v['seeds']:6d} closure={v['closure']:6d} " +
          ' '.join(f'{kk}={v[kk]}' for kk in ('ok_eligible', 'c_recent', 'b_over30', 'x_unknown', 'a_no_source')))
