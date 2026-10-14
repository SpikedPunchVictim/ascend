# EV-69: arm each session by its beads SessionStart deliveries, then count sessions that ran bd recall.
# Usage: python3 -I grade.py <handlers check --json output> <measuring session id prefix> <bd memories --json> [<probe session id prefix>...]
# A probe session is one a measurement launched (EV-55's quiz and probe runs); it is not a working session.
import collections, json, math, sys
d = json.load(open(sys.argv[1])); me = sys.argv[2]
keys = set(k for k, v in json.load(open(sys.argv[3])).items() if isinstance(v, str))
probes = tuple(sys.argv[4:])
rows = collections.defaultdict(list)
for r in d['rows']:
    if r['field'].startswith('sample'): rows[r['handler']].append(r['value'])
    elif r['handler'] == '(log)' and r['field'] in ('files', 'events', 'first_ts', 'last_ts'): print(f"log {r['field']}: {r['value']}")
arm, first = collections.defaultdict(set), {}
for v in rows['beads-delivery']:
    s = v['session_id']
    arm[s].add('index' if 'bd-prime-hook' in v['fields']['command'] else 'full')
    first[s] = min(first.get(s, v['ts']), v['ts'])
def real(v, word): return v['fields']['argv'].startswith(f'bd {word}')
rec = [v for v in rows['beads-recall'] if real(v, 'recall')]
mem = [v for v in rows['beads-memories'] if real(v, 'memories')]
print(f"rows: recall {len(rows['beads-recall'])} matched, {len(rec)} are the command itself; memories {len(rows['beads-memories'])} matched, {len(mem)} the command itself; deliveries {len(rows['beads-delivery'])}")
by = lambda vs: collections.Counter(v['session_id'] for v in vs)
rs, ms = by(rec), by(mem)
groups = collections.defaultdict(list)
for s, a in arm.items():
    groups['excluded: measuring session' if s.startswith(me) else 'excluded: probe launched by EV-55' if probes and s.startswith(probes) else 'excluded: both forms' if len(a) > 1 else next(iter(a))].append(s)
no_delivery = (set(rs) | set(ms)) - set(arm)
print(f"sessions with a beads delivery: {len(arm)}; sessions with a recall or memories call and no delivery: {len(no_delivery)}")
def wilson(k, n):
    if not n: return 'n/a'
    z = 1.96; p = k / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); den = 1 + z * z / n
    return f'{k}/{n} = {p:.1%} ({(c - h) / den:.1%}-{(c + h) / den:.1%})'
for g in sorted(groups):
    ss = groups[g]
    print(f"{g}: sessions {len(ss)}{' (anecdote, under 20)' if len(ss) < 20 else ''}; first delivery {min(first[s] for s in ss)[:10]} to {max(first[s] for s in ss)[:10]}")
    print(f"    ran bd recall: {wilson(sum(1 for s in ss if rs[s]), len(ss))}; recall calls {sum(rs[s] for s in ss)}")
    print(f"    ran bd memories: {wilson(sum(1 for s in ss if ms[s]), len(ss))}; memories calls {sum(ms[s] for s in ss)}")
    ks = [v['fields']['argv'].split()[2] if len(v['fields']['argv'].split()) > 2 else '' for v in rec if v['session_id'] in set(ss)]
    if ks:
        line = f"    keys recalled: {len(ks)} calls, {len(set(ks))} distinct"
        if keys is not None: line += f"; naming a stored key: {sum(k in keys for k in ks)} of {len(ks)}"
        print(line + '; ' + ', '.join(f'{k} x{n}' for k, n in collections.Counter(ks).most_common(8)))
