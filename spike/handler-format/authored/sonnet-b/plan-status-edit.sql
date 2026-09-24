-- plan-status-edit
SELECT file, seq, stage, from_status, to_status
FROM (
  SELECT
    e.file AS file,
    e.seq AS seq,
    basename(e.path) AS stage,
    CASE WHEN regex_capture(e.before, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i') IS NULL
         THEN NULL
         ELSE snake(regex_capture(e.before, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i'))
    END AS from_status,
    snake(regex_capture(e.after, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i')) AS to_status,
    regex_capture(e.before, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i') AS old_word,
    regex_capture(e.after, '\*\*Status:\s*(Not Started|In Progress|Complete|Blocked)', 1, 'i') AS new_word
  FROM events e
  WHERE e.kind = 'file.changed'
    AND regexp_i('PLAN\.md$', e.path)
)
WHERE new_word IS NOT NULL
  AND (old_word IS NULL OR old_word <> new_word)
ORDER BY file, seq
