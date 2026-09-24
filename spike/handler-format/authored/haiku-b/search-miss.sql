-- search-miss
WITH zero_hits AS (
  SELECT 
    e.file,
    e.seq,
    e.call,
    e.pattern,
    e.via
  FROM events e
  WHERE e.kind = 'search.run'
    AND e.hits = 0
),
later_hits AS (
  SELECT 
    z.file,
    z.seq,
    z.pattern,
    z.via,
    e.pattern as corrected_pattern,
    ROW_NUMBER() OVER (PARTITION BY z.seq ORDER BY e.call) as rn
  FROM zero_hits z
  JOIN events e ON e.file = z.file
    AND e.kind = 'search.run'
    AND e.hits > 0
    AND e.call > z.call
    AND e.call <= z.call + 5
    AND shares_token(z.pattern, e.pattern) = 1
)
SELECT 
  file,
  seq,
  pattern,
  '0' as returned,
  corrected_pattern as corrected_by,
  via as search_tool
FROM later_hits
WHERE rn = 1
