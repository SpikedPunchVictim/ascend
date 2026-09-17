import { wilson } from '@ascend/analysis';
import {
  OUTPUT_CONTRACT_VERSION,
  render,
  renderCsv,
  renderJson,
  renderProportion,
  renderTable,
  type JsonEnvelope,
} from '@ascend/cli';
import { describe, expect, it } from 'vitest';

/**
 * `output.ts` -- the renderers, at their boundaries.
 *
 * This file did not exist before `asc-bcv.19`. Truncation was covered only through commands
 * (`init.test.ts` notes the 60-character elision in a comment), which is coverage of the
 * *default* width and nothing else -- and the defect was in the cut, so the default was the
 * one width that could not show it.
 *
 * The central assertion is not "the cell looks right". It is **the cell encodes**: every
 * string the table produces is handed to the same UTF-8 encoder that writes stdout, and a
 * lone surrogate is only a defect because that encoder cannot represent one. Asserting on
 * `Buffer.from(cell, 'utf8')` is therefore the closest a unit test can stand to the wire
 * without spawning a process, and `query.test.ts` carries the spawned case beside this one.
 */

/** The 60-unit default, restated here so a change to it fails this file loudly. */
const DEFAULT_WIDTH = 60;

const cell = (value: unknown, width?: number): string => {
  const output = { columns: ['v'], rows: [{ v: value }] };
  const table = width === undefined ? renderTable(output) : renderTable(output, width);
  // Row 0 is the header, row 1 the dashes, row 2 the single value.
  return table.split('\n')[2] ?? '';
};

/**
 * Every code unit index holding an unpaired surrogate, scanning the whole string.
 *
 * Scanning rather than testing one index, because the claim is "the truncation created
 * none" and a check that looks only where the cut landed would accept a string that was
 * malformed anywhere else.
 */
function unpairedSurrogates(text: string): readonly number[] {
  const found: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else found.push(i);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      found.push(i);
    }
  }
  return found;
}

/** What actually reaches the wire: the encoder is where a lone surrogate becomes U+FFFD. */
const encodes = (text: string): boolean =>
  !Buffer.from(text, 'utf8').toString('utf8').includes('�');

const EMOJI = '\u{1F600}'; // two UTF-16 units
const CJK_EXT_B = '\u{20000}'; // also two, and not an emoji -- the class is "above U+FFFF"

/**
 * The old rule, kept here as the reference a regression is measured against: cut at
 * `maxCellWidth - 1` code units with no regard for what is at that index. Pinning the
 * difference between the two is how "this changed nothing else" becomes checkable.
 */
const oldCell = (text: string, maxCellWidth: number): string =>
  text.length > maxCellWidth ? `${text.slice(0, maxCellWidth - 1)}…` : text;

/**
 * The new rule (`asc-i36`): keep a head AND a tail, split the elidable budget evenly, head taking
 * the odd unit. This is a plain reference with no surrogate awareness -- correct only for text with
 * no astral characters near either cut -- so the tests below use it strictly for ASCII content, and
 * check surrogate safety at each boundary separately.
 */
const newCell = (text: string, maxCellWidth: number): string => {
  if (text.length <= maxCellWidth) return text;
  const budget = Math.max(0, maxCellWidth - 1);
  if (budget === 0) return '…';
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return tail === 0
    ? `${text.slice(0, head)}…`
    : `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
};

/** The head and tail budgets `truncateCell` computes for `maxCellWidth`, restated for the tests. */
const budgets = (maxCellWidth: number): { readonly head: number; readonly tail: number } => {
  const budget = Math.max(0, maxCellWidth - 1);
  const head = Math.ceil(budget / 2);
  return { head, tail: budget - head };
};

describe('the table never cuts a character in half', () => {
  it('keeps both halves of a surrogate pair straddling the HEAD cut', () => {
    // `head - 1` a's put the pair's high half at the last unit the head keeps and its low half
    // one past it -- exactly the straddling condition `lastUnitToKeep` exists to catch.
    const { head } = budgets(DEFAULT_WIDTH);
    const value = `${'a'.repeat(head - 1)}${EMOJI}${'b'.repeat(DEFAULT_WIDTH + 20)}`;
    const rendered = cell(value);

    expect(unpairedSurrogates(rendered)).toEqual([]);
    expect(encodes(rendered)).toBe(true);
    // Backs off by exactly one unit: the pair is dropped whole into the elided middle rather
    // than split, so the kept head is one unit SHORTER than the budget, not the pair kept intact.
    expect(rendered.startsWith(`${'a'.repeat(head - 1)}…`)).toBe(true);
  });

  it('keeps both halves of a surrogate pair straddling the TAIL cut', () => {
    // The mirror construction: `tail - 1` b's after the pair put its low half exactly at the
    // first unit the tail keeps and its high half one before it.
    const { tail } = budgets(DEFAULT_WIDTH);
    const value = `${'a'.repeat(DEFAULT_WIDTH + 20)}${EMOJI}${'b'.repeat(Math.max(tail - 1, 0))}`;
    const rendered = cell(value);

    expect(unpairedSurrogates(rendered)).toEqual([]);
    expect(encodes(rendered)).toBe(true);
    expect(rendered.endsWith(`…${'b'.repeat(Math.max(tail - 1, 0))}`)).toBe(true);
  });

  it('cuts every offset in the neighbourhood of BOTH boundaries cleanly, not only the reported one', () => {
    // The bead named one offset, for one boundary. This walks the neighbourhood of each boundary
    // at several widths, because a fix written against a single offset is a fix that may cover
    // only that offset -- and a head+tail cut has two boundaries to miss.
    const failures: string[] = [];
    for (const width of [10, 30, DEFAULT_WIDTH, 61, 120]) {
      const { head, tail } = budgets(width);
      for (let offset = -3; offset <= 3; offset++) {
        const headPad = Math.max(0, head - 1 + offset);
        const headValue = `${'a'.repeat(headPad)}${EMOJI}${'b'.repeat(width + 20)}`;
        const headRendered = cell(headValue, width);
        if (!encodes(headRendered) || unpairedSurrogates(headRendered).length > 0) {
          failures.push(`head width=${String(width)} offset=${String(offset)}`);
        }

        const tailPad = Math.max(0, tail - 1 + offset);
        const tailValue = `${'a'.repeat(width + 20)}${EMOJI}${'b'.repeat(tailPad)}`;
        const tailRendered = cell(tailValue, width);
        if (!encodes(tailRendered) || unpairedSurrogates(tailRendered).length > 0) {
          failures.push(`tail width=${String(width)} offset=${String(offset)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('holds for every astral character, not only the emoji the audit happened to use', () => {
    // The mechanism is "a character above U+FFFF is two code units", so the test has to
    // come from the class rather than from one member of it. Checked at both boundaries.
    const astral = [0x1f600, 0x20000, 0x10ffff, 0x1d11e, 0x1f1ef, 0x10000];
    const { head, tail } = budgets(DEFAULT_WIDTH);
    const failures: string[] = [];
    for (const point of astral) {
      const char = String.fromCodePoint(point);
      for (let offset = -1; offset <= 1; offset++) {
        const headValue = `${'a'.repeat(Math.max(0, head - 1 + offset))}${char}${'b'.repeat(80)}`;
        if (!encodes(cell(headValue)))
          failures.push(`head U+${point.toString(16)} o=${String(offset)}`);

        const tailValue = `${'a'.repeat(80)}${char}${'b'.repeat(Math.max(0, tail - 1 + offset))}`;
        if (!encodes(cell(tailValue)))
          failures.push(`tail U+${point.toString(16)} o=${String(offset)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('survives a value that is nothing but astral characters', () => {
    // No ASCII anywhere to anchor either cut: several consecutive pairs, so both cuts land
    // inside the sequence rather than at either edge of it.
    const failures: string[] = [];
    for (let n = 1; n <= 40; n++) {
      const rendered = cell(EMOJI.repeat(n));
      if (!encodes(rendered)) failures.push(`n=${String(n)}`);
    }
    expect(failures).toEqual([]);
  });

  it('is total at the widths below one, where the budget goes negative', () => {
    // `slice(0, -1)` is a slice from the END, so a width of 0 used to drop the last unit --
    // which mints a lone surrogate when that unit was a low half. No caller passes such a
    // width today; the arithmetic should not depend on that staying true.
    const failures: string[] = [];
    for (const width of [-5, -1, 0, 1, 2, 3]) {
      for (const value of [EMOJI, `${EMOJI}${EMOJI}`, `${'a'.repeat(70)}${EMOJI}`, 'plain']) {
        const rendered = cell(value, width);
        if (!encodes(rendered))
          failures.push(`width=${String(width)} ${JSON.stringify(value.slice(0, 4))}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/**
 * `asc-i36` deliberately changed WHAT is elided (a head-only cut became a head+tail cut), so this
 * block no longer compares against `oldCell` for every width -- it does that only at the widths
 * where the two rules agree by construction (no room for a tail), and against `newCell` -- the
 * documented new rule -- everywhere else. The width and the ellipsis-marks-a-cut contract are
 * exactly what did NOT change, and that is what the rest of this block asserts.
 */
describe('the cut changed nothing except which side is elided', () => {
  it('matches the old rule exactly at widths with no room for a tail', () => {
    // Budget `maxCellWidth - 1` below 2 leaves nothing for a tail (`tail === 0`), so
    // `truncateCell` degenerates to the same head-only cut the old rule always was.
    const corpus = ['short', 'x'.repeat(DEFAULT_WIDTH), 'no astral here but long enough'];
    const differences: string[] = [];
    for (const value of corpus) {
      for (const width of [1, 2]) {
        const flattened = value.replace(/\s+/g, ' ').trim();
        const expected = oldCell(flattened, width);
        const actual = cell(value, width);
        if (actual !== expected)
          differences.push(`${JSON.stringify(value.slice(0, 12))} w=${String(width)}`);
      }
    }
    expect(differences).toEqual([]);
  });

  it('matches the documented new rule exactly, for every ASCII-only value', () => {
    // The strongest available statement that the implementation does what `truncateCell`'s
    // comment says: a corpus of ASCII-only values (so `newCell`'s lack of surrogate awareness
    // cannot matter), each rendered at several widths, compared byte for byte against the plain
    // reference split.
    const corpus = [
      '',
      'short',
      'x'.repeat(DEFAULT_WIDTH - 1),
      'x'.repeat(DEFAULT_WIDTH),
      'x'.repeat(DEFAULT_WIDTH + 1),
      'x'.repeat(200),
      'no astral here, but plenty of words to push the cell past its budget and elide it',
      'tabs\tand\nnewlines collapse',
    ];
    const differences: string[] = [];
    for (const value of corpus) {
      for (const width of [1, 2, 3, 10, DEFAULT_WIDTH, 120]) {
        const flattened = value.replace(/\s+/g, ' ').trim();
        const expected = newCell(flattened, width);
        const actual = cell(value, width);
        if (actual !== expected)
          differences.push(`${JSON.stringify(value.slice(0, 12))} w=${String(width)}`);
      }
    }
    expect(differences).toEqual([]);
  });

  it('still marks a cut with the ellipsis, so a prefix is never passed off as a value', () => {
    // The ellipsis now sits BETWEEN the head and the tail rather than at the end -- `includes`,
    // not `endsWith`, is the correct assertion once a value has a tail to end with instead.
    const rendered = cell('y'.repeat(200));
    expect(rendered).toContain('…');
    expect(rendered.length).toBe(DEFAULT_WIDTH);
  });

  it('does not touch a value that fits, so the common case pays nothing', () => {
    const exact = 'z'.repeat(DEFAULT_WIDTH);
    expect(cell(exact)).toBe(exact);
    expect(unpairedSurrogates(EMOJI.repeat(20))).toEqual([]); // 40 units: fits, and is intact
    expect(cell(EMOJI.repeat(20))).toBe(EMOJI.repeat(20));
  });
});

/**
 * `asc-i36`'s own motivating case, reproduced without a store: two ids with a long shared prefix
 * and a short discriminating suffix, which the old head-only rule rendered identically.
 */
describe('a head+tail cut tells apart what a head-only cut could not (asc-i36)', () => {
  const idA =
    'derived:claude-code:verification_run:09054587-df6b-4091-8698-8ba05bcd6636:toolu_015cLxDpX8GQSi3CtuKSnzYi';
  const idB =
    'derived:claude-code:verification_run:09054587-df6b-4091-8698-8ba05bcd6636:toolu_019LZNEkMTxbkGfaySaFv6ke';

  it('collided under the old head-only rule -- the defect this bead fixes, pinned as a fact', () => {
    expect(idA).not.toBe(idB);
    expect(oldCell(idA, DEFAULT_WIDTH)).toBe(oldCell(idB, DEFAULT_WIDTH));
  });

  it('renders the two ids to two distinct cells under the new rule', () => {
    const renderedA = cell(idA);
    const renderedB = cell(idB);
    expect(renderedA).not.toBe(renderedB);
    expect(renderedA).toContain('…');
    expect(renderedB).toContain('…');
    // Both the shared prefix and each id's own discriminating suffix survive the cut.
    expect(renderedA.startsWith('derived:claude-code:')).toBe(true);
    expect(renderedA.endsWith(idA.slice(-10))).toBe(true);
    expect(renderedB.endsWith(idB.slice(-10))).toBe(true);
  });
});

describe('a malformed value already in the input is carried, not hidden', () => {
  it('passes through an unpaired surrogate the caller supplied', () => {
    // Deliberately NOT sanitised. A lone surrogate in a stored value is a defect about the
    // write path; `--json` escapes it, `--csv` carries it verbatim, and a table that
    // silently rewrote it would make the three views disagree about the same row. The
    // claim this fix makes is the narrow one: truncation never CREATES one.
    //
    // Placed as the very first unit, so it lands inside the kept HEAD regardless of exactly
    // where the head/tail split falls -- the expected position does not depend on that split.
    const malformed = `\uD83D${'a'.repeat(70)}`;
    expect(unpairedSurrogates(cell(malformed))).toEqual([0]);
  });

  it('passes through an unpaired surrogate the caller supplied, in the TAIL', () => {
    // The mirror case: a lone low surrogate as the very last unit lands inside the kept tail
    // regardless of the split, since the tail always ends where the value does.
    const malformed = `${'a'.repeat(70)}\uDC00`;
    const rendered = cell(malformed);
    expect(unpairedSurrogates(rendered)).toEqual([rendered.length - 1]);
  });
});

describe('the version a consumer branches on', () => {
  it('is 2, and changing it has to be deliberate', () => {
    // The one place the literal is written down. Every other suite asserts against the exported
    // constant, which is right -- they are testing that commands agree with the contract, not what
    // the contract says -- but it left the number itself unguarded, so a bump would have been a
    // silent change to a published shape. It is 2 because `assist` became unconditional on
    // `asc search`: a consumer that read the block's ABSENCE as "this search succeeded" is now
    // wrong, and one that read `reason` as always naming a failure is wrong for `rows-returned`.
    // Both are breaking readings of a field that looks unchanged, which is precisely what a
    // contract version is for. If you are here to change this number, say in the comment why.
    expect(OUTPUT_CONTRACT_VERSION).toBe(2);
  });
});

/**
 * `asc-7mv` -- CSV formula injection, mitigated. `csvField`'s comment (`packages/cli/src/output.ts`)
 * records the reversal: a leading `=`/`+`/`-`/`@`/tab/CR now gets a leading `'`, UNLESS the whole
 * field parses as a finite number -- which is what keeps an ordinary negative number readable while
 * still catching an injected formula. `--csv-raw` is the escape hatch for a caller who needs the
 * original bytes back regardless. This test pins the new behaviour so a future change to `csvField`
 * has to update it deliberately rather than by drifting past it.
 */
describe('CSV neutralises a leading formula-trigger character, except a bare finite number (asc-7mv)', () => {
  it('prefixes a leading =, +, - or @ with a single quote', () => {
    const output = {
      columns: ['v'],
      rows: [{ v: '=CMD(bad)' }, { v: '+mention' }, { v: '-danger' }, { v: '@handle' }],
    };

    const lines = renderCsv(output).split('\n');
    expect(lines).toStrictEqual(['v', "'=CMD(bad)", "'+mention", "'-danger", "'@handle"]);
  });

  it('leaves a bare finite number untouched, however it is written', () => {
    // This exemption is the whole reason the mitigation is affordable: a negative number is
    // ordinary output from this CLI, and `-3.14` must read back as the number it is.
    const output = {
      columns: ['v'],
      rows: [{ v: '-3.14' }, { v: '+5' }, { v: '-0' }, { v: '1e6' }],
    };
    const lines = renderCsv(output).split('\n');
    expect(lines).toStrictEqual(['v', '-3.14', '+5', '-0', '1e6']);
  });

  it('treats a bare trigger character with nothing after it as text, not a number', () => {
    // `Number('-')`, `Number('+')` and `Number('=')` are all `NaN` -- none of these is the numeric
    // exemption, so each is neutralised like any other non-numeric trigger cell.
    const output = { columns: ['v'], rows: [{ v: '-' }, { v: '+' }, { v: '=' }] };
    const lines = renderCsv(output).split('\n');
    expect(lines).toStrictEqual(['v', "'-", "'+", "'="]);
  });

  it("leaves an empty field empty -- Number('') is 0 in JavaScript, which is not this field", () => {
    const output = { columns: ['v'], rows: [{ v: '' }] };
    expect(renderCsv(output)).toBe('v\n');
  });

  it('still quotes a neutralised cell per RFC 4180 when it also needs it', () => {
    // A comma forces quoting regardless of the leading character -- the two rules are independent,
    // and this proves the quoting rule did not change just because the neutralisation rule did.
    const output = { columns: ['v'], rows: [{ v: '=A,B' }] };
    expect(renderCsv(output)).toBe('v\n"\'=A,B"');
  });

  it('--csv-raw skips neutralisation and emits the byte-faithful RFC 4180 field', () => {
    const output = {
      columns: ['v'],
      rows: [{ v: '=CMD(bad)' }, { v: '+1' }, { v: '-5' }, { v: '@mention' }],
    };

    const lines = renderCsv(output, true).split('\n');
    expect(lines).toStrictEqual(['v', '=CMD(bad)', '+1', '-5', '@mention']);
  });

  it('--csv-raw still quotes per RFC 4180 -- the two rules stay orthogonal either way', () => {
    const output = { columns: ['v'], rows: [{ v: '=A,B' }] };
    expect(renderCsv(output, true)).toBe('v\n"=A,B"');
  });
});

describe('the other two renderers are unchanged by any of this', () => {
  it('does not truncate at all, so no cut exists to get wrong', () => {
    const value = `${'a'.repeat(58)}${EMOJI}${'b'.repeat(20)}`;
    const output = { columns: ['v'], rows: [{ v: value }] };

    expect(renderJson(output)).toContain(value);
    expect(renderCsv(output)).toContain(value);
    const envelope: JsonEnvelope = JSON.parse(renderJson(output)) as JsonEnvelope;
    expect(envelope.ascend_output).toBe(OUTPUT_CONTRACT_VERSION);
    expect(encodes(renderJson(output))).toBe(true);
    expect(encodes(renderCsv(output))).toBe(true);
  });

  it('renders the same astral value in all three views, agreeing about what it holds', () => {
    // `render` is the seam a command goes through, so the three formats are checked
    // through it rather than through their own functions: a command that picked one
    // renderer directly would bypass this. The emoji sits at unit 10, well inside the head
    // half of the table's cut, so it survives the table's truncation as well as the other two
    // renderers' lack of one.
    const value = `${'a'.repeat(10)}${EMOJI}${'b'.repeat(60)}`;
    const output = { columns: ['v'], rows: [{ v: value }] };
    expect(render('csv', output)).toContain(value);
    expect(render('json', output)).toContain(value);
    expect(render('table', output)).toContain(EMOJI);
  });
});

/**
 * `asc-tif` -- `SampleReport.requested`, the field that makes a sampler's silent under-return
 * visible. `chooseSample` (`packages/cli/src/explore-sample.ts`) is what decides when to set it;
 * this only checks that once set, the table renderer says something a reader would notice rather
 * than folding it away.
 */
describe('the sample block names a shortfall the sampler did not fill', () => {
  it('adds a line when the sample fell short of what was requested', () => {
    const output = {
      columns: ['v'],
      rows: [{ v: 1 }, { v: 2 }, { v: 3 }],
      coverage: { shown: 3, total: 39, has_more: false, percent: 7.7 },
      sample: { mode: 'diverse', strata: [], requested: 8 },
    };

    const table = renderTable(output);
    expect(table).toContain('diverse');
    expect(table).toContain('held fewer rows than the 8 requested');
  });

  it('says nothing extra when the sample met its request', () => {
    const output = {
      columns: ['v'],
      rows: [{ v: 1 }, { v: 2 }],
      coverage: { shown: 2, total: 39, has_more: false, percent: 5.1 },
      sample: { mode: 'diverse', strata: [] },
    };

    const table = renderTable(output);
    expect(table).not.toContain('requested');
  });
});

describe('the elision is bounded by the width it was given', () => {
  it('keeps every cell at or under the width, for astral and non-astral alike', () => {
    const failures: string[] = [];
    for (const width of [5, 10, 60, 61]) {
      for (const value of ['q'.repeat(300), EMOJI.repeat(150), CJK_EXT_B.repeat(150)]) {
        const rendered = cell(value, width);
        if (rendered.length > width)
          failures.push(`w=${String(width)} len=${String(rendered.length)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('narrows by at most one unit when it has to step over a surrogate half', () => {
    // The one visible consequence of the fix, pinned so it cannot grow silently: a HEAD cut
    // that splits a pair is one unit narrower than the budget allowed; a placement one unit
    // earlier does not straddle the boundary at all and loses nothing to the backoff.
    const { head } = budgets(DEFAULT_WIDTH);
    const split = cell(`${'a'.repeat(head - 1)}${EMOJI}${'b'.repeat(100)}`);
    expect(split.length).toBe(DEFAULT_WIDTH - 1);
    const intact = cell(`${'a'.repeat(head)}${EMOJI}${'b'.repeat(100)}`);
    expect(intact.length).toBe(DEFAULT_WIDTH);
  });
});

/**
 * Every byte outside printable ASCII, scanning the whole string.
 *
 * The same shape as `unpairedSurrogates` above and for the same reason: the claim is "this
 * rendering is ASCII", and a check that looked only at the separator would accept a non-ASCII
 * character anywhere else in it.
 */
function nonAscii(text: string): readonly string[] {
  const found: string[] = [];
  // `for...of` rather than a spread or `.split('')`: it iterates code POINTS, so a character
  // above U+FFFF is one element and is reported as the character rather than as two halves.
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x20 || code > 0x7e) found.push(character);
  }
  return found;
}

describe('renderProportion', () => {
  it('renders the shape ARCHITECTURE.md prescribes, and the spike produced', () => {
    // The spike's own anchor, character for character: `formatProportion(25, 100)` in
    // `spike/lib/stats.mjs` returned exactly this. A port that changed the rendering would
    // still be a port, but this is what makes the two provably the same output.
    expect(renderProportion(wilson(25, 100))).toBe('25.0% (95% CI 17.5-34.3%, n=100)');
  });

  it('renders no estimate for n=0, rather than 0%', () => {
    expect(renderProportion(wilson(0, 0))).toBe('n=0 (no estimate)');
    // The distinction that matters: a group with nothing in it must not print a percentage.
    expect(renderProportion(wilson(0, 0))).not.toContain('0.0%');
  });

  it('takes the level from the proportion, so the label cannot contradict the arithmetic', () => {
    // The defect the port closed. In the spike, `formatProportion(25, 100, z)` printed the
    // literal "95% CI" whatever `z` was, so any other level produced a label that disagreed
    // with the bounds beside it.
    expect(renderProportion(wilson(25, 100, 0.9))).toContain('(90% CI');
    expect(renderProportion(wilson(25, 100, 0.95))).toContain('(95% CI');
    expect(renderProportion(wilson(25, 100, 0.99))).toContain('(99% CI');
    // And the wider level really is wider, so the label is not merely relabelling one interval.
    const ninety = renderProportion(wilson(25, 100, 0.9));
    const ninetyNine = renderProportion(wilson(25, 100, 0.99));
    expect(ninety).not.toBe(ninetyNine);
  });

  it('carries the small-group flag with the threshold it was compared against', () => {
    const flagged = renderProportion(wilson(3, 9));
    expect(flagged).toContain('SMALL GROUP');
    expect(flagged).toContain('n=9 < 20');
    expect(flagged).toContain('treat as anecdote, not estimate');
  });

  it('still prints the interval for a small group rather than suppressing it', () => {
    // Hiding a correct number because it is weakly evidenced is its own dishonesty. A reader
    // needs the number AND the reason not to lean on it, so both must be present.
    const flagged = renderProportion(wilson(3, 9));
    expect(flagged).toContain('33.3%');
    expect(flagged).toContain('CI');
    expect(flagged).toContain('n=9');
  });

  it('does not flag a group at or above the threshold', () => {
    expect(renderProportion(wilson(4, 20))).not.toContain('SMALL GROUP');
    expect(renderProportion(wilson(5, 21))).not.toContain('SMALL GROUP');
  });

  it('never prints a percentage without a denominator', () => {
    // The smallest thing that makes a percentage safe to read, checked across the sweep rather
    // than at one n. A rendering that dropped `n` would pass every test above it.
    for (const [successes, n] of [
      [0, 1],
      [3, 9],
      [4, 20],
      [25, 100],
      [222, 409],
    ] as const) {
      const rendered = renderProportion(wilson(successes, n));
      expect(rendered).toContain(`n=${String(n)}`);
      expect(rendered).toContain('CI');
    }
  });

  it('is ASCII, which is a decision and not an accident', () => {
    // ARCHITECTURE.md's example wrote the interval with an en dash (U+2013) between the bounds.
    // The evidence overruled it -- 0 of every file under `packages/*/src` and `packages/*/test`
    // contain a non-ASCII byte, and this string lands in table cells and CSV fields. Pinned as a
    // check rather than left as a comment, because "we decided ASCII" is exactly the kind of
    // decision that gets silently reverted by the next person who copies the example from the doc.
    const failures: string[] = [];
    for (const [successes, n] of [
      [0, 1],
      [3, 9],
      [4, 20],
      [25, 100],
      [222, 409],
      [10, 10],
    ] as const) {
      for (const level of [0.9, 0.95, 0.99] as const) {
        const rendered = renderProportion(wilson(successes, n, level));
        const found = nonAscii(rendered);
        if (found.length > 0)
          failures.push(
            `n=${String(n)}: ${found.map((c) => `U+${c.codePointAt(0)?.toString(16) ?? '?'}`).join(' ')}`,
          );
      }
    }
    expect(failures).toEqual([]);
  });
});
