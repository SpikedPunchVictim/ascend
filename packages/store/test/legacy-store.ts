/**
 * The pre-cutover shape of a store, spelled out here because the current schema no longer makes it.
 *
 * **Not collected as a suite: `.test.ts` is what vitest includes, so this file is imported rather
 * than run.** It lives under `test/` rather than in `src/` because nothing the product ships needs
 * it -- the same reason `packages/cli/test/helpers.ts` exists.
 *
 * `ingest_cursor` was created by migration 4, which was deleted on 2026-09-29 (`asc-i5tj.14`) when
 * the ingest cursor became `${store}/ingest-cursor.json`. The DDL below is verbatim from the deleted
 * `INGEST_CURSOR` const, and it is kept in ONE place because two suites need to build the same
 * store, for opposite reasons: the migration must still NOTICE the rows and report them among the
 * tables it drops (`migrate.test.ts`), and the cursor module must still IGNORE them
 * (`ingest-cursor.test.ts`). A copy of the DDL in each file would be two chances for the historical
 * shape to drift apart, and the shape is the whole point -- a fixture that got it slightly wrong
 * would test a store that never existed.
 *
 * Nothing in `src/` writes this table any more, and no migration creates it. So a test that needs
 * one has to make it, which is what `exec`ing this against a fresh store does.
 */
export const LEGACY_INGEST_CURSOR_DDL = `
CREATE TABLE ingest_cursor (
  path        TEXT    NOT NULL PRIMARY KEY,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  ingested_at TEXT    NOT NULL,

  CHECK (path <> ''),
  CHECK (mtime_ms >= 0),
  CHECK (size >= 0),
  CHECK (ingested_at <> '')
);
`;
