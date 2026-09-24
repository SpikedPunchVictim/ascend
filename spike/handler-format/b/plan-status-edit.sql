SELECT file, seq, basename(path) AS stage, snake(fr) AS from_status, snake(t) AS to_status
FROM (
  SELECT file, seq, path,
    regex_capture(after,  '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i') AS t,
    regex_capture(before, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i') AS fr
  FROM events
  WHERE kind = 'file.changed' AND regexp_i('IMPLEMENTATION_PLAN\.md$|PLAN\.md$', path)
)
WHERE t IS NOT NULL AND coalesce(fr, '') <> t
