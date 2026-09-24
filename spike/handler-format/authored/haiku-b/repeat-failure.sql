-- repeat-failure
SELECT 
  e.file,
  e.seq,
  e.head as command,
  (SELECT COUNT(*) FROM events e2
   WHERE e2.file = e.file
     AND e2.kind = 'command.run'
     AND e2.ok = 0
     AND e2.call > e.call
     AND e2.call <= e.call + 10
     AND e2.head = e.head) as failed_again
FROM events e
WHERE e.kind = 'command.run'
  AND e.ok = 0
HAVING failed_again >= 1
