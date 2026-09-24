SELECT file, seq, head AS command, n AS failed_again
FROM (
  SELECT e.file, e.seq, e.head,
    (SELECT count(*) FROM events f
     WHERE f.file = e.file AND f.seq > e.seq AND f.call BETWEEN e.call AND e.call + 10
       AND f.kind = 'command.run' AND f.head = e.head AND f.ok = 0 AND f.call > e.call) AS n
  FROM events e
  WHERE e.kind = 'command.run' AND e.ok = 0
)
WHERE n >= 1
