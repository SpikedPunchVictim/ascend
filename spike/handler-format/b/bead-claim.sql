SELECT e.file, e.seq, j.value AS stage, 'in_progress' AS to_status
FROM events e, json_each(e.argv) j
WHERE e.kind = 'command.run' AND e.ok = 1 AND e.head = 'bd'
  AND json_extract(e.argv, '$[1]') = 'update'
  AND (EXISTS (SELECT 1 FROM json_each(e.argv) a
               WHERE a.value = '--claim' OR a.value REGEXP '^--status[= ]?in_progress$')
    OR EXISTS (SELECT 1 FROM json_each(e.argv) a, json_each(e.argv) b
               WHERE b.key = a.key + 1 AND a.value = '--status' AND b.value = 'in_progress'))
  AND j.key >= 2 AND j.value REGEXP '^[a-z]+-[a-z0-9]+(\.[0-9]+)*$'
