# Diagnose where my per-trigger result/cwd differs from replay.py's own scan of the transcripts.
import glob, json, os, re, sys
trig=[json.loads(l) for l in open(sys.argv[1])]
trig.sort(key=lambda t:(t['session'],t['agent'],t['seq']))
ids={t['id'] for t in trig}
SHA_LINE=re.compile(r'^\[[^\]\n]*?\b([0-9a-f]{7,40})\] ',re.M)
res={}
dupe=0
for path in glob.glob(os.path.join(sys.argv[2],'**','*.jsonl'),recursive=True):
    try: fh=open(path,encoding='utf-8',errors='replace')
    except OSError: continue
    for line in fh:
        if '"tool_result"' not in line: continue
        try: rec=json.loads(line)
        except ValueError: continue
        content=(rec.get('message') or {}).get('content')
        if not isinstance(content,list): continue
        for part in content:
            if isinstance(part,dict) and part.get('type')=='tool_result' and part.get('tool_use_id') in ids:
                c=part.get('content')
                text=c if isinstance(c,str) else '\n'.join(x.get('text','') if isinstance(x,dict) else str(x) for x in (c or []))
                k=(rec.get('sessionId'),part['tool_use_id'])
                if k in res: dupe+=1
                res[k]=(text,rec.get('cwd') or '',bool(part.get('is_error')))
print('replay-map entries',len(res),'dupe overwrites',dupe)
miss_txt=0; miss_null=0; diff_txt=0; sha_replay=0; sha_mine=0
for t in trig:
    rp=res.get((t['session'],t['id']))
    if rp is None:
        miss_txt+=1
    else:
        if rp[0]!= (t.get('result') or ''): diff_txt+=1
        if SHA_LINE.findall(rp[0]): sha_replay+=1
    if t.get('result') is None: miss_null+=1
    if t.get('result') and SHA_LINE.findall(t['result']): sha_mine+=1
print('triggers',len(trig),'replay missing for',miss_txt,'mine result null',miss_null,'text differs',diff_txt)
print('sha-bearing: replay-map',sha_replay,'mine',sha_mine)
# how many triggers have the same (session,id) as another -> k indexing
from collections import Counter
c=Counter((t['session'],t['id']) for t in trig)
print('distinct calls',len(c),'max segs',max(c.values()))
