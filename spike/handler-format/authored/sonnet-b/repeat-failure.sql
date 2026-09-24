-- repeat-failure
SELECT file, seq, command, failed_again
FROM (
  SELECT
    e.file AS file,
    e.seq AS seq,
    e.head AS command,
    (SELECT COUNT(*)
       FROM events f
      WHERE f.kind = 'command.run'
        AND f.file = e.file
        AND f.seq > e.seq
        AND f.call > e.call
        AND f.call <= e.call + 10
        AND f.head = e.head
        AND f.ok = 0) AS failed_again
  FROM events e
  WHERE e.kind = 'command.run'
    AND e.ok = 0
)
WHERE failed_again >= 1
ORDER BY file, seq
