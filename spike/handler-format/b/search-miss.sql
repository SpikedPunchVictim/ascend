SELECT e.file, e.seq, e.pattern, '0' AS returned,
  (SELECT f.pattern FROM events f
   WHERE f.file = e.file AND f.seq > e.seq AND f.call BETWEEN e.call AND e.call + 5
     AND f.kind = 'search.run' AND f.hits > 0 AND shares_token(e.pattern, f.pattern)
   ORDER BY f.seq LIMIT 1) AS corrected_by,
  e.via AS search_tool
FROM events e
WHERE e.kind = 'search.run' AND e.hits = 0 AND corrected_by IS NOT NULL
