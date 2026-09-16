import {
  OUTPUT_CONTRACT_VERSION,
  render,
  renderCsv,
  renderJson,
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

describe('the table never cuts a character in half', () => {
  it('keeps both halves of a surrogate pair that straddles the cut', () => {
    // 58 a's put the emoji at units 58-59, and the trailing 20 push the value past the
    // width so a cut happens at all. Without them the value is 60 units and is not cut --
    // which is exactly how the audit's repro missed the rendered cell.
    const value = `${'a'.repeat(58)}${EMOJI}${'b'.repeat(20)}`;
    const rendered = cell(value);

    expect(unpairedSurrogates(rendered)).toEqual([]);
    expect(encodes(rendered)).toBe(true);
    expect(rendered).toBe(`${'a'.repeat(58)}…`);
  });

  it('cuts every offset in the neighbourhood cleanly, not only the reported one', () => {
    // The bead named one offset. This walks the whole neighbourhood of the cut, because a
    // fix written against a single offset is a fix that may cover only that offset.
    const failures: string[] = [];
    for (let pad = 40; pad <= 70; pad++) {
      const rendered = cell(`${'a'.repeat(pad)}${EMOJI}${'b'.repeat(20)}`);
      if (!encodes(rendered))
        failures.push(`pad=${String(pad)} ${JSON.stringify(rendered.slice(-3))}`);
    }
    expect(failures).toEqual([]);
  });

  it('holds for every astral character, not only the emoji the audit happened to use', () => {
    // The mechanism is "a character above U+FFFF is two code units", so the test has to
    // come from the class rather than from one member of it.
    const astral = [0x1f600, 0x20000, 0x10ffff, 0x1d11e, 0x1f1ef, 0x10000];
    const failures: string[] = [];
    for (const point of astral) {
      for (let pad = 57; pad <= 60; pad++) {
        const rendered = cell(`${'a'.repeat(pad)}${String.fromCodePoint(point)}${'b'.repeat(20)}`);
        if (!encodes(rendered)) failures.push(`U+${point.toString(16)} pad=${String(pad)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('survives a value that is nothing but astral characters', () => {
    // No ASCII anywhere to anchor the cut: several consecutive pairs, so the cut lands
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

describe('the cut changed nothing except the defect', () => {
  it('renders every non-astral value exactly as the old rule did', () => {
    // The strongest available statement that this fix did not quietly re-width the table.
    // A corpus of ASCII-only values, each rendered at several widths, compared byte for
    // byte against the rule the fix replaced.
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
      for (const width of [1, 2, 10, DEFAULT_WIDTH, 120]) {
        const flattened = value.replace(/\s+/g, ' ').trim();
        const expected = oldCell(flattened, width);
        const actual = cell(value, width);
        if (actual !== expected)
          differences.push(`${JSON.stringify(value.slice(0, 12))} w=${String(width)}`);
      }
    }
    expect(differences).toEqual([]);
  });

  it('still marks a truncation with the ellipsis, so a prefix is never passed off as a value', () => {
    const rendered = cell('y'.repeat(200));
    expect(rendered.endsWith('…')).toBe(true);
    expect(rendered.length).toBe(DEFAULT_WIDTH);
  });

  it('does not touch a value that fits, so the common case pays nothing', () => {
    const exact = 'z'.repeat(DEFAULT_WIDTH);
    expect(cell(exact)).toBe(exact);
    expect(unpairedSurrogates(EMOJI.repeat(20))).toEqual([]); // 40 units: fits, and is intact
    expect(cell(EMOJI.repeat(20))).toBe(EMOJI.repeat(20));
  });
});

describe('a malformed value already in the input is carried, not hidden', () => {
  it('passes through an unpaired surrogate the caller supplied', () => {
    // Deliberately NOT sanitised. A lone surrogate in a stored value is a defect about the
    // write path; `--json` escapes it, `--csv` carries it verbatim, and a table that
    // silently rewrote it would make the three views disagree about the same row. The
    // claim this fix makes is the narrow one: truncation never CREATES one.
    const malformed = `${'a'.repeat(58)}\uD83D${'b'.repeat(20)}`;
    expect(unpairedSurrogates(cell(malformed))).toEqual([58]);
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
    // renderer directly would bypass this.
    const value = `${'a'.repeat(30)}${EMOJI}${'b'.repeat(30)}`;
    const output = { columns: ['v'], rows: [{ v: value }] };
    expect(render('csv', output)).toContain(value);
    expect(render('json', output)).toContain(value);
    expect(render('table', output)).toContain(EMOJI);
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
    // The one visible consequence of the fix, pinned so it cannot grow silently: a cell
    // whose cut splits a pair is one unit narrower than the budget allowed.
    const split = cell(`${'a'.repeat(58)}${EMOJI}${'b'.repeat(20)}`);
    expect(split.length).toBe(DEFAULT_WIDTH - 1);
    const intact = cell(`${'a'.repeat(59)}${EMOJI}${'b'.repeat(20)}`);
    expect(intact.length).toBe(DEFAULT_WIDTH);
  });
});
