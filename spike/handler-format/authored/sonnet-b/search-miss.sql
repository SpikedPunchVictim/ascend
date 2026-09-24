-- search-miss
SELECT file, seq, pattern, returned, corrected_by, search_tool
FROM (
  SELECT
    e.file AS file,
    e.seq AS seq,
    e.pattern AS pattern,
    0 AS returned,
    (SELECT f.pattern
       FROM events f
      WHERE f.kind = 'search.run'
        AND f.file = e.file
        AND f.seq > e.seq
        AND f.call BETWEEN e.call AND e.call + 5
        AND f.hits > 0
        AND shares_token(e.pattern, f.pattern)
      ORDER BY f.seq
      LIMIT 1) AS corrected_by,
    e.via AS search_tool
  FROM events e
  WHERE e.kind = 'search.run'
    AND e.hits = 0
)
WHERE corrected_by IS NOT NULL
ORDER BY file, seq
