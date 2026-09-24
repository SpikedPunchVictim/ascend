-- bead-close
SELECT 
  e.file, 
  e.seq,
  value as stage,
  'complete' as to_status
FROM events e,
  json_each(e.argv)
WHERE e.kind = 'command.run'
  AND e.ok = 1
  AND e.head = 'bd'
  AND json_extract(e.argv, '$[1]') = 'close'
  AND key >= 2
  AND value REGEXP '^[a-z]+-[a-z0-9]+(\.[0-9]+)*$'
