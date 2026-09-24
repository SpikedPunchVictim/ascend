-- plan-status-edit
WITH status_extract AS (
  SELECT 
    e.file,
    e.seq,
    basename(e.path) as stage,
    regex_capture(e.before, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i') as old_status,
    regex_capture(e.after, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i') as new_status
  FROM events e
  WHERE e.kind = 'file.changed'
    AND regexp_i('PLAN\.md$', e.path) = 1
)
SELECT 
  file,
  seq,
  stage,
  CASE WHEN old_status IS NOT NULL THEN snake(old_status) ELSE NULL END as from_status,
  snake(new_status) as to_status
FROM status_extract
WHERE new_status IS NOT NULL
  AND (old_status IS NULL OR old_status != new_status)
