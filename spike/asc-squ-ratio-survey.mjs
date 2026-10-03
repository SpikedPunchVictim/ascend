/**
 * asc-squ — re-measure the promotion condition.
 *
 * The deferral's condition is "a real caller with non-Latin evidence hits the under-estimate". The
 * 2026-09-18 pass answered it over `evidence_text` only (69 of 1,799 entries carried one). This scan
 * is wider on purpose: EVERY string value in every record, broken down by field, because a script
 * that is absent from `evidence_text` and present in a `note` is still content the budget has to fit.
 *
 * Read-only. Counts and code points only -- no record text is printed.
 *
 * **Why this lives in the repo rather than in `/tmp`.** It is the source of the figure quoted in
 * `IMPLEMENTATION_PLAN.md` Stage E14 — "6,885 records, 110,050 string values, 0 of every non-Latin
 * script" — and a figure whose script was deleted is exactly what `dogfood/0057` records: a number
 * that survives into a plan with no way to re-derive it. Run it from the repo root:
 *
 *     node spike/asc-squ-ratio-survey.mjs
 *
 * The numbers above are the run of 2026-10-03 against `.ascend/entries`; the script re-derives them,
 * so a later run that disagrees is a finding rather than a mystery.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RANGES = [
  ['CJK (han/kana/hangul)', /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/],
  ['Cyrillic', /[Ѐ-ӿԀ-ԯ]/],
  ['Arabic', /[؀-ۿݐ-ݿ]/],
  ['Hebrew', /[֐-׿]/],
  ['Devanagari', /[ऀ-ॿ]/],
  ['Thai', /[฀-๿]/],
  ['Emoji/pictographs', /[\u{2600}-\u{27BF}\u{FE0F}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}]/u],
  ['Fullwidth/CJK punctuation', /[　-〿＀-￯]/],
];

/** A string counts as non-ASCII if any code point is > 0x7f. Everything else is classified below. */
const NON_ASCII = /[^\x00-\x7f]/;

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.jsonl')) files.push(path);
  }
})('.ascend/entries');

const codePoints = new Map();
const perRange = new Map(RANGES.map(([n]) => [n, 0]));
const perField = new Map(); // field -> {strings, nonAscii, ranges}
const rangeFields = new Map(); // range -> Set(field)
let records = 0;
let strings = 0;
let nonAsciiStrings = 0;
let evidenceTexts = 0;
let evidenceTextsNonAscii = 0;

const visit = (field, value) => {
  if (typeof value === 'string') {
    strings += 1;
    let slot = perField.get(field);
    if (!slot) perField.set(field, (slot = { strings: 0, nonAscii: 0, ranges: new Map() }));
    slot.strings += 1;
    if (field === 'evidence_text') evidenceTexts += 1;
    if (NON_ASCII.test(value)) {
      nonAsciiStrings += 1;
      slot.nonAscii += 1;
      if (field === 'evidence_text') evidenceTextsNonAscii += 1;
      for (const ch of value) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7f) codePoints.set(cp, (codePoints.get(cp) ?? 0) + 1);
      }
      for (const [name, re] of RANGES) {
        if (re.test(value)) {
          perRange.set(name, perRange.get(name) + 1);
          slot.ranges.set(name, (slot.ranges.get(name) ?? 0) + 1);
          if (!rangeFields.has(name)) rangeFields.set(name, new Set());
          rangeFields.get(name).add(field);
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) visit(field, v);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) visit(k, v);
  }
};

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    records += 1;
    visit('<root>', row);
  }
}

console.log(`store: ${files.length} record file(s), ${records} record(s), ${strings} string value(s)`);
console.log(`non-ASCII string values: ${nonAsciiStrings}`);
console.log(`evidence_text: ${evidenceTextsNonAscii} non-ASCII of ${evidenceTexts}\n`);

console.log('script                     string values containing it');
let anyScript = false;
for (const [name] of RANGES) {
  const n = perRange.get(name);
  if (n > 0) anyScript = true;
  console.log(`${name.padEnd(28)} ${String(n).padStart(6)}   ${n > 0 ? 'fields: ' + [...(rangeFields.get(name) ?? [])].join(', ') : ''}`);
}
console.log(`\nany non-Latin script present: ${anyScript ? 'YES' : 'NO'}`);

console.log('\nevery non-ASCII code point present, by block:');
const BLOCKS=[[0x80,0xff,'Latin-1 Supplement'],[0x100,0x17f,'Latin Extended-A'],[0x180,0x24f,'Latin Extended-B'],[0x2000,0x206f,'General Punctuation'],[0x2070,0x209f,'Super/Subscripts'],[0x20a0,0x20cf,'Currency Symbols'],[0x2100,0x214f,'Letterlike Symbols'],[0x2190,0x21ff,'Arrows'],[0x2200,0x22ff,'Math Operators'],[0x2500,0x257f,'Box Drawing'],[0x25a0,0x25ff,'Geometric Shapes'],[0x2600,0x26ff,'Misc Symbols'],[0x2700,0x27bf,'Dingbats'],[0x3000,0x303f,'CJK Punctuation'],[0xff00,0xffef,'Fullwidth Forms']];
const byBlock=new Map();
for(const [cp,n] of codePoints){const b=BLOCKS.find(([lo,hi])=>cp>=lo&&cp<=hi);const k=b?b[2]:'U+'+cp.toString(16).toUpperCase().padStart(4,'0');byBlock.set(k,(byBlock.get(k)??0)+n);}
for(const [k,n] of [...byBlock.entries()].sort((a,b)=>b[1]-a[1]))console.log('   '+k.padEnd(26)+String(n).padStart(6));

console.log('\nfield                strings   non-ASCII   scripts');
for (const [field, s] of [...perField.entries()].sort((a, b) => b[1].nonAscii - a[1].nonAscii || b[1].strings - a[1].strings)) {
  if (s.nonAscii === 0 && s.strings < 500) continue;
  const scripts = [...s.ranges.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '-';
  console.log(`${field.padEnd(20)}${String(s.strings).padStart(7)}${String(s.nonAscii).padStart(12)}   ${scripts}`);
}
