-- bead-claim
SELECT 
  e.file, 
  e.seq,
  value as stage,
  'in_progress' as to_status
FROM events e,
  json_each(e.argv)
WHERE e.kind = 'command.run'
  AND e.ok = 1
  AND e.head = 'bd'
  AND json_extract(e.argv, '$[1]') = 'update'
  AND key >= 2
  AND value REGEXP '^[a-z]+-[a-z0-9]+(\.[0-9]+)*$'
  AND (
    EXISTS (
      SELECT 1 FROM json_each(e.argv) 
      WHERE value = '--claim'
    )
    OR
    EXISTS (
      SELECT 1 FROM json_each(e.argv) 
      WHERE value REGEXP '^--status[= ]?in_progress$'
    )
    OR
    EXISTS (
      SELECT 1 FROM json_each(e.argv) as je1
      WHERE je1.value = '--status'
        AND json_extract(e.argv, '$[' || (je1.key + 1) || ']') = 'in_progress'
    )
  )
