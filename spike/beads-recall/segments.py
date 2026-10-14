# EV-69, NOT REGISTERED: the same question with the unit changed from a session to a delivery segment
# (one beads SessionStart delivery up to the next one in the same session). Deliveries under 60 s apart are one segment.
# Usage: python3 -I segments.py <handlers check --json output> <excluded session id prefix>...
import bisect, collections, datetime, json, math, sys
d = json.load(open(sys.argv[1])); skip = tuple(sys.argv[2:])
rows = collections.defaultdict(list)
for r in d['rows']:
    if r['field'].startswith('sample'): rows[r['handler']].append(r['value'])
t = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
dels = collections.defaultdict(list)
print('deliveries by stream:', dict(collections.Counter('main' if v['agent_id'] == 'main' else 'subagent' for v in rows['beads-delivery'])))
for v in rows['beads-delivery']:
    if not v['session_id'].startswith(skip): dels[v['session_id']].append((t(v['ts']), 'index' if 'bd-prime-hook' in v['fields']['command'] else 'full'))
segs = collections.defaultdict(list)  # session -> [(start, arm)]
for s, ds in dels.items():
    for at, arm in sorted(ds):
        if not segs[s] or at - segs[s][-1][0] >= 60 or arm != segs[s][-1][1]: segs[s].append((at, arm))
hit = {w: collections.Counter() for w in ('recall', 'memories')}
for w in hit:
    for v in rows['beads-' + w]:
        s = v['session_id']
        if s in segs and v['fields']['argv'].startswith('bd ' + w):
            i = bisect.bisect_right([a for a, _ in segs[s]], t(v['ts'])) - 1
            if i >= 0: hit[w][(s, i)] += 1
def wilson(k, n):
    z = 1.96; p = k / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); den = 1 + z * z / n
    return f'{k}/{n} = {p:.1%} ({(c - h) / den:.1%}-{(c + h) / den:.1%})'
for arm in ('full', 'index'):
    ss = [(s, i) for s, v in segs.items() for i, (_, a) in enumerate(v) if a == arm]
    if not ss: print(arm, 'segments 0'); continue
    print(f"{arm}: segments {len(ss)}{' (anecdote, under 20)' if len(ss) < 20 else ''} in {len({s for s, _ in ss})} sessions; with bd recall {wilson(sum(1 for k in ss if hit['recall'][k]), len(ss))}; with bd memories {wilson(sum(1 for k in ss if hit['memories'][k]), len(ss))}")
