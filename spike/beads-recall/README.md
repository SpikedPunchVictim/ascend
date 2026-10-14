# Do sessions use the beads memory index? (EV-69, asc-09wx.7)

Three handlers in `handlers/` give the rows: `beads-recall`, `beads-memories`, `beads-delivery`.

```bash
node packages/cli/dist/bin.js handlers check handlers/beads-recall.yaml handlers/beads-memories.yaml \
  handlers/beads-delivery.yaml --samples 100000 --json > check.json
bd memories --json > memories.json
python3 -I spike/beads-recall/grade.py check.json <measuring session id prefix> memories.json <probe session id prefix>...
python3 -I spike/beads-recall/segments.py check.json <excluded session id prefix>...
```

`grade.py` is the registered analysis: the unit is a session, armed by which form of the beads
context its SessionStart deliveries carried. `segments.py` is the unregistered one with the unit
changed to a delivery segment. EV-55's four probe sessions are named in `docs/evidence/EV-69.md`
and are passed as probes every time.
