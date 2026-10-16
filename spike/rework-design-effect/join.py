# asc-lspj: EV-61's join, transcribed from the surviving ev61/replay.py with the unit key passed
# through (replay.py drops it, and the design effect is per unit).
#
# The join block -- SHA_LINE, the k-th sha indexing, the +-1 s quiet-commit window, the global
# same-commit dedup, the eligibility test and the 180-day/50-commit threshold -- is copied from
# replay.py line for line so the two cannot disagree. `spike/rework-design-effect/join-funnel.txt`
# is replay.py run unmodified on the same envelope, for comparison.
#
# Usage:
#   python3 -I join.py <triggers.jsonl> <envelope.json> <out.jsonl>
import bisect, collections, datetime, json, os, re, subprocess, sys

epoch = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() if s else None
DAY = 86400
# EV-61's list (replay.py). The outcome side (EV-63) adds .jsonl/.csv/.tsv/.log and .ascend//.beads/.
NOT_SOURCE = re.compile(r'(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|package\.json|CHANGELOG\.md)$|\.(md|mdx|snap|svg|png|jpg|json|lock|txt)$', re.I)
SHA_LINE = re.compile(r'^\[[^\]\n]*?\b([0-9a-f]{7,40})\] ', re.M)

trig_path, env_path, out_path = sys.argv[1:4]
root = sys.argv[4]
rows = [json.loads(l) for l in open(trig_path)]
rows.sort(key=lambda t: (t['session'], t['agent'], t['seq']))

# ---- the result for each trigger's call, scanned exactly as replay.py scans it: match a
# `tool_result` block by its `tool_use_id` alone, and take the cwd, timestamp and is_error from the
# record that carried the result. ----
import glob
need = {t['id'] for t in rows}
result = {}
for path in glob.glob(os.path.join(root, '**', '*.jsonl'), recursive=True):
    try:
        fh = open(path, encoding='utf-8', errors='replace')
    except OSError:
        continue
    for line in fh:
        if '"tool_result"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        content = (rec.get('message') or {}).get('content')
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and part.get('type') == 'tool_result' and part.get('tool_use_id') in need:
                c = part.get('content')
                text = c if isinstance(c, str) else '\n'.join(x.get('text', '') if isinstance(x, dict) else str(x) for x in (c or []))
                result[part['tool_use_id']] = (text, rec.get('cwd') or '', bool(part.get('is_error')), epoch(rec.get('timestamp')))
sys.stderr.write(f'results_found {len(result)}\n')

# ---- envelope for replay.py (unmodified), so its funnel can be compared ----
env_rows = [dict(handler='(log)', field='files', value=0),
            dict(handler='(log)', field='events', value=len(rows))]
for i, t in enumerate(rows):
    env_rows.append(dict(handler='commit-made', field=f'sample[{i}]', value=dict(
        session_id=t['session'], agent_id=t['agent'], seq=t['seq'], call=t['call'], ts=t['ts'],
        fields=dict(id=t['id'], argv=t['argv']))))
json.dump(dict(rows=env_rows), open(env_path, 'w'))

repos = {}
def top(cwd):
    if cwd not in repos:
        r = subprocess.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], capture_output=True, text=True) if cwd and os.path.isdir(cwd) else None
        repos[cwd] = r.stdout.strip() if r and r.returncode == 0 else None
    return repos[cwd]

hist = {}
def history(repo):
    if repo not in hist:
        raw = subprocess.run(['git', '-C', repo, 'log', '--all', '--no-merges', '--format=%x1e%H%x1f%ct%x1f', '--numstat', '--no-renames'], capture_output=True, text=True, errors='replace').stdout
        commits, touches = {}, collections.defaultdict(list)
        for rec in raw.split('\x1e')[1:]:
            p = rec.split('\x1f')
            files = [(f[2], int(f[0])) for f in (l.split('\t') for l in p[2].strip().split('\n')) if len(f) == 3 and f[0].isdigit()]
            n_files = len([l for l in p[2].strip().split('\n') if l.count('\t') == 2])
            src = [(f, a) for f, a in files if a > 0 and not NOT_SOURCE.search(f)]
            commits[p[0]] = dict(at=int(p[1]), src=src, eligible=bool(src) and n_files <= 30)
            for f, _ in files:
                if not NOT_SOURCE.search(f):
                    touches[f].append(int(p[1]))
        for t in touches.values():
            t.sort()
        for c in commits.values():
            c['added'] = sum(a for _, a in c['src'])
        elig = sorted((c['at'], c['added']) for c in commits.values() if c['eligible'])
        hist[repo] = (commits, elig, [e[0] for e in elig], sorted((c['at'], s) for s, c in commits.items()))
    return hist[repo]

funnel = collections.Counter()
per_repo = collections.defaultdict(collections.Counter)
lost = collections.Counter()
per_call = collections.Counter()
seen_sha = set()
out = []

def emit(t, repo, route, sha, fate, eligible=None):
    out.append(dict(unit=t['unit'], session=t['session'], agent=t['agent'], seq=t['seq'], call=t['call'],
                    id=t['id'], ts=t['ts'], repo=repo, route=route, sha=sha, ev61_eligible=eligible, fate=fate))

for t in rows:
    funnel['triggers'] += 1
    key = (t['session'], t['id'])
    k = per_call[key]; per_call[key] += 1
    hit = result.get(t['id'])
    if hit is None:                                  # replay.py: key not in `result`
        funnel['no_tool_result'] += 1; emit(t, None, None, None, 'no_tool_result'); continue
    text, cwd, err, ended = hit
    if err:                                          # replay.py: the result carried is_error
        funnel['call_errored'] += 1; emit(t, None, None, None, 'call_errored'); continue
    m = re.search(r'git(?: -c \S+)* -C (\S+)', t['argv'])
    repo = top(os.path.join(cwd, m.group(1).strip('\'"')) if m else cwd)
    if not repo:
        funnel['no_repository_at_cwd'] += 1; emit(t, None, None, None, 'no_repository'); continue
    commits, elig, elig_t, by_time = history(repo)
    base = os.path.basename(repo)
    per_repo[base]['triggers_in_repo'] += 1
    shas = SHA_LINE.findall(text)
    if k < len(shas):
        full = [s for s in commits if s.startswith(shas[k])]
        route = 'sha'
    else:
        a, b = epoch(t['ts']) - 1, (ended or 0) + 1
        window = [s for at, s in by_time[bisect.bisect_left(by_time, (a, '')):bisect.bisect_right(by_time, (b, '~'))]]
        n_quiet = sum(1 for x in rows if x['session'] == t['session'] and x['id'] == t['id']) - len(shas)
        full = [window[k - len(shas)]] if len(window) == n_quiet else []
        route = 'time'
    if len(full) != 1:
        fixture = bool(re.search(r'-c user\.|--allow-empty|commit -q?a?m \S{1,12}$|commit -q?a?m "[^"]{1,14}"$', t['argv']))
        lost[(base, 'fixture_like' if fixture else 'other', 'main' if t['agent'] == 'main' else 'subagent')] += 1
        funnel['commit_not_found_in_repository'] += 1
        emit(t, base, None, None, 'commit_not_found'); continue
    funnel['joined_by_' + route] += 1
    per_repo[base]['joined'] += 1
    if (repo, full[0]) in seen_sha:
        funnel['same_commit_again'] += 1; emit(t, base, route, full[0], 'same_commit_again'); continue
    seen_sha.add((repo, full[0]))
    c = commits[full[0]]
    if not c['eligible']:
        funnel['not_eligible_no_source_or_over_30_files'] += 1
        emit(t, base, route, full[0], 'not_eligible', False); continue
    i, j = bisect.bisect_left(elig_t, c['at'] - 180 * DAY), bisect.bisect_left(elig_t, c['at'])
    if j - i < 50:
        funnel['no_threshold_yet'] += 1
        emit(t, base, route, full[0], 'no_threshold', True); continue
    funnel['graded'] += 1
    emit(t, base, route, full[0], 'graded', True)

with open(out_path, 'w') as fh:
    for r in out:
        fh.write(json.dumps(r) + '\n')
print('log', json.dumps(dict(files=0, events=len(rows))))
print('funnel', json.dumps(dict(funnel)))
print('rows_written', len(out))
print('join_by_repo', json.dumps({r: dict(v) for r, v in sorted(per_repo.items(), key=lambda x: -x[1]['triggers_in_repo'])}))
print('per_repo_trigger_sum', sum(v['triggers_in_repo'] for v in per_repo.values()))
