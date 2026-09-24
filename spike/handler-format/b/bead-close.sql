SELECT e.file, e.seq, j.value AS stage, 'complete' AS to_status
FROM events e, json_each(e.argv) j
WHERE e.kind = 'command.run' AND e.ok = 1 AND e.head = 'bd'
  AND json_extract(e.argv, '$[1]') = 'close'
  AND j.key >= 2 AND j.value REGEXP '^[a-z]+-[a-z0-9]+(\.[0-9]+)*$'
