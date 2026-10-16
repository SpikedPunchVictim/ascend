# asc-lspj: per-unit rework outcome, the funnel, and the three aggregation rules.
#
# The outcome is EV-63's `reworked_7` and its eligibility rule, read from the saved per-repo
# numstat.log + traced.tsv. The load() below is analyse.py's, kept character for character so the
# pair sets (p7) and the eligibility test cannot drift from the numbers EV-63 published.
#
# Usage: python3 -I effect.py <join.jsonl> <out-prefix> name=dir ...
import bisect, collections, json, re, sys

NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt|jsonl|csv|tsv|log)$|(^|/)\.(ascend|beads)/', re.I)
DAY = 86400
join_path, prefix, specs = sys.argv[1], sys.argv[2], [a.split('=', 1) for a in sys.argv[3:]]

def load(d):
    commits, touches = {}, collections.defaultdict(list)
    for rec in open(d + '/numstat.log', encoding='utf-8', errors='replace').read().split('\x1e')[1:]:
        p = rec.split('\x1f')
        lines = [l.split('\t') for l in p[3].strip().split('\n') if l.count('\t') == 2]
        files = [(f[2], int(f[0])) for f in lines if f[0].isdigit()]
        commits[p[0]] = dict(at=int(p[1]), files=files, n_files=len(lines))
        for f, _ in files:
            if not NOT_SOURCE.search(f):
                touches[f].append(int(p[1]))
    last = max(c['at'] for c in commits.values())
    p7 = set()
    for line in open(d + '/traced.tsv'):
        rw, rw_at, intro, f, n = line.rstrip('\n').split('\t')
        c = commits.get(intro)
        if not c or intro == rw:
            continue
        lag = int(rw_at) - c['at']
        if 0 < lag <= 7 * DAY:                 # EV-63's reworked_7 window (inner guard is 7 days)
            p7.add((intro, f))
    for sha, c in commits.items():
        src = [(f, a) for f, a in c['files'] if a > 0 and not NOT_SOURCE.search(f)]
        c['eligible'] = bool(src) and c['n_files'] <= 30 and c['at'] <= last - 7 * DAY
        c['reworked_7'] = any((sha, f) in p7 for f, _ in src)
    return commits, last

by_repo = {}
sha_index = {}
for name, d in specs:
    commits, last = load(d)
    by_repo[name] = dict(commits=len(commits), last=last,
                         eligible=sum(1 for c in commits.values() if c['eligible']),
                         reworked_7=round(sum(c['reworked_7'] for c in commits.values() if c['eligible']) / max(sum(1 for c in commits.values() if c['eligible']), 1), 4))
    for sha, c in commits.items():
        sha_index[(name, sha)] = c

rows = [json.loads(l) for l in open(join_path)]
JOINED = {'graded', 'not_eligible', 'no_threshold'}

# per unit: the joined commits, in trigger order, with the repo-local outcome
per_unit = collections.defaultdict(list)
funnel = collections.Counter()
for r in rows:
    funnel['triggers'] += 1
for r in rows:
    if r['fate'] in ('no_tool_result',):
        funnel['f_no_tool_result'] += 1; continue
    if r['fate'] == 'call_errored':
        funnel['f_call_errored'] += 1; continue
    if r['fate'] == 'no_repository':
        funnel['f_no_repository'] += 1; continue
    if r['fate'] == 'commit_not_found':
        funnel['f_commit_not_found'] += 1; continue
    if r['fate'] == 'same_commit_again':
        funnel['f_same_commit_again'] += 1; continue
    c = sha_index.get((r['repo'], r['sha']))
    if c is None:
        funnel['f_commit_outside_ev63_trace'] += 1
        per_unit[r['unit']].append(dict(repo=r['repo'], sha=r['sha'], route=r['route'], ts=r['ts'], at=None,
                                        eligible=False, outcome=None))
        continue
    funnel['f_joined_known_commit'] += 1
    outcome = None
    if c['eligible']:
        outcome = 1 if c['reworked_7'] else 0
        funnel['f_commit_eligible_ev63'] += 1
    else:
        funnel['f_commit_not_eligible_ev63'] += 1
    per_unit[r['unit']].append(dict(repo=r['repo'], sha=r['sha'], route=r['route'], ts=r['ts'], at=c['at'],
                                    eligible=c['eligible'], outcome=outcome))

# A trigger that never reached a repo (no_repository/call_errored/...) still belongs to a unit; the
# unit set is the 852 the replay produced, so every trigger's unit is recorded above only when it
# got past the result/error checks. Recover the rest from the full row list for the unit count.
all_units = {r['unit'] for r in rows}
TRACED = set(n for n, _ in specs)

units_with_commit = {u for u, cs in per_unit.items() if cs}
units_in_traced_repo = {u for u, cs in per_unit.items() if any(c['repo'] in TRACED for c in cs)}
units_dated = {u for u, cs in per_unit.items() if cs and any(c['ts'] for c in cs)}
units_eligible = {u for u, cs in per_unit.items() if any(c['eligible'] for c in cs)}
units_gradable = {u for u, cs in per_unit.items() if any(c['outcome'] is not None for c in cs)}

def agg(cs, rule):
    graded = [c for c in cs if c['outcome'] is not None]
    if rule.endswith('_sha'):
        graded = [c for c in graded if c['route'] == 'sha']
    if not graded:
        return None
    base = rule[:-4] if rule.endswith('_sha') else rule
    if base == 'any':
        return 1 if any(c['outcome'] for c in graded) else 0
    if base == 'all':
        return 1 if all(c['outcome'] for c in graded) else 0
    if base == 'first':
        return graded[0]['outcome']
    if base == 'last':
        return graded[-1]['outcome']
    raise ValueError(rule)

out = dict(funnel={k: funnel[k] for k in sorted(funnel)},
           units=dict(total=len(all_units), with_commit=len(units_with_commit),
                      in_traced_repo=len(units_in_traced_repo), dated=len(units_dated),
                      eligible=len(units_eligible), gradable=len(units_gradable)),
           per_repo={n: by_repo[n] for n, _ in specs}, rules={})
for rule in ('any', 'all', 'first', 'last', 'first_sha', 'any_sha'):
    pairs = sorted((u, agg(cs, rule)) for u, cs in per_unit.items())
    pairs = [(u, o) for u, o in pairs if o is not None]
    outcomes = [o for _, o in pairs]
    out['rules'][rule] = dict(n=len(pairs), rate=round(sum(outcomes) / len(outcomes), 4) if outcomes else None,
                              ones=sum(outcomes))
RULES = ('any', 'all', 'first', 'last', 'first_sha', 'any_sha')
json.dump(dict(out, outcomes={r: [[u, agg(cs, r)] for u, cs in sorted(per_unit.items()) if agg(cs, r) is not None] for r in RULES}),
          open(prefix + '-effect.json', 'w'), indent=1)
for k in ('funnel', 'units', 'per_repo'):
    print(k, json.dumps(out[k]))
print('rules')
for r, v in out['rules'].items():
    print('   ', r, json.dumps(v))
