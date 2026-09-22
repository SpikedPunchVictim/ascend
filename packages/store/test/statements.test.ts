import { describe, expect, it } from 'vitest';
import { PredicateError, statementCount, wrapPredicate } from '../src/index.js';

/**
 * The statement scanner, and the predicate wrap built on it.
 *
 * Moved here from `packages/cli/test/query.test.ts` on 2026-09-17 with the function itself, which
 * now lives in `packages/store/src/statements.ts` because the fact it encodes is a fact about
 * `db.prepare`. The CLI still re-exports it, so the assertions below are the same ones; what changed
 * is which package owns them.
 */

describe('the statement scanner', () => {
  it('counts one statement however it is spelled', () => {
    // Each of these is ONE statement with a `;` that must not separate: a literal, a doubled escape
    // inside a literal, a doubled quote inside an identifier, a bracket, and a line comment. An
    // undercount here is the defect the scanner exists to prevent, and it is invisible from the
    // command -- a dropped second statement looks exactly like a query that returned fewer rows.
    for (const sql of [
      'SELECT 1',
      'SELECT 1;',
      "SELECT ';' AS semi",
      "SELECT 'it''s; fine' AS quoted",
      'SELECT "a"";b" AS ident',
      'SELECT `a``;b` AS backtick',
      'SELECT [a;b] AS bracketed',
      'SELECT 1 -- ; not a separator',
      'SELECT 1 /* ; neither is this */',
      '  SELECT 1  ;  ',
    ]) {
      expect(statementCount(sql), sql).toBe(1);
    }
  });

  it('counts what is genuinely more than one', () => {
    expect(statementCount('SELECT 1; SELECT 2')).toBe(2);
    expect(statementCount('SELECT 1; SELECT 2; SELECT 3')).toBe(3);
    expect(statementCount('SELECT 1;;SELECT 2')).toBe(2);
    // A `;` inside a comment does not hide a real separator that follows it.
    expect(statementCount('SELECT 1 -- x\n; SELECT 2')).toBe(2);
  });

  it('counts nothing for what SQLite would refuse as an empty statement', () => {
    expect(statementCount('')).toBe(0);
    expect(statementCount('   \n\t ')).toBe(0);
    expect(statementCount(';')).toBe(0);
    expect(statementCount('-- only a comment')).toBe(0);
    expect(statementCount('/* only a comment */')).toBe(0);
  });
});

describe('wrapping a predicate', () => {
  it('returns the statement a single-condition predicate lands in', () => {
    expect(wrapPredicate('entries', "type_name = 'decision'")).toBe(
      "SELECT id FROM entries WHERE (type_name = 'decision')",
    );
  });

  it('refuses a predicate that smuggles in a second statement', () => {
    // The hazard this exists for, and it is not hypothetical: measured 2026-09-17, `db.prepare()`
    // accepts `'SELECT a FROM t WHERE (a > 0); DROP TABLE t; --)'`, returns the FIRST statement's
    // rows, and silently discards the rest -- so a fragment like this one does not fail, it produces
    // a match count from a truncated predicate. Refused before prepare ever sees it.
    expect(() => wrapPredicate('entries', '1=1); DELETE FROM annotations; --')).toThrow(
      PredicateError,
    );
    expect(() => wrapPredicate('entries', '1=1); DELETE FROM annotations; --')).toThrow(
      /must be a single condition/,
    );
    expect(() => wrapPredicate('entries', '1=1); DELETE FROM annotations; --')).toThrow(
      /makes 2 statements/,
    );
  });

  it('accepts a semicolon inside a string literal, because that is not a separator', () => {
    // The line the check draws, and it is the scanner's line rather than a second rule: a `;` in a
    // quoted literal is content. Refusing it here would make a legitimate predicate unstorable, and
    // the message would name a statement count that was never written.
    expect(wrapPredicate('entries', "evidence_text LIKE '%a;b%'")).toBe(
      "SELECT id FROM entries WHERE (evidence_text LIKE '%a;b%')",
    );
  });

  it('accepts an empty predicate, which matches everything, and refuses only what is unsafe', () => {
    // `WHERE ()` is a syntax error SQLite reports as such, and that is the right layer for it: this
    // function refuses what would be SILENTLY wrong, not everything that is wrong. A predicate of
    // `1=1` is the honest way to say "every entry", and it wraps to one statement.
    expect(wrapPredicate('entries', '1=1')).toBe('SELECT id FROM entries WHERE (1=1)');
  });
});
