-- bead-claim
SELECT e.file, e.seq, j.value AS stage, 'in_progress' AS to_status
FROM events e, json_each(e.argv) j
WHERE e.kind = 'command.run'
  AND e.ok = 1
  AND e.head = 'bd'
  AND json_extract(e.argv, '$[1]') = 'update'
  AND j.key >= 2
  AND j.value REGEXP '^[a-z]+-[a-z0-9]+(\.[0-9]+)*$'
  AND EXISTS (
    SELECT 1
    FROM json_each(e.argv) a
    WHERE a.key >= 2
      AND (
        a.value = '--claim'
        OR a.value REGEXP '^--status[= ]?in_progress$'
        OR (a.value = '--status'
            AND json_extract(e.argv, '$[' || (a.key + 1) || ']') = 'in_progress')
      )
  )
ORDER BY e.file, e.seq, j.key
