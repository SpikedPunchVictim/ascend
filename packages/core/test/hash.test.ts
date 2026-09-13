import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalizeTypeSpec,
  nonJsonReason,
  sha256Hex,
  typeHash,
} from '../src/index.js';

/**
 * The vectors below are the PUBLISHED SHA-256 test values (FIPS 180-4 / NIST examples).
 *
 * This matters more than usual: a hand-written hash is self-consistent by construction,
 * so every property test ("same input, same output") would pass against an
 * implementation that is simply wrong. Only external vectors can tell the difference.
 * If these pass, the implementation is SHA-256; if they were dropped, nothing else here
 * would notice a broken round function.
 *
 * The chosen lengths also exercise the padding boundaries: 0 bytes, 3 bytes, and 56
 * bytes (which forces the extra block, since 56 + 1 > 56 leaves no room for the
 * 8-byte length), plus many blocks.
 */
const VECTORS: readonly (readonly [string, string])[] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

/**
 * Multibyte vectors, whose expected values were produced by `shasum -a 256` over the
 * raw UTF-8 bytes -- an implementation entirely independent of this one.
 *
 * They exist because utf8() is hand-written: the ASCII vectors above would pass even
 * if every multi-byte branch were wrong, since they never leave the single-byte path.
 * Each length class is covered -- 2, 3 and 4 bytes.
 */
const UTF8_VECTORS: readonly (readonly [string, string, string])[] = [
  ['e-acute (2-byte)', 'café', '850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e'],
  ['euro sign (3-byte)', '€', 'c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d'],
  [
    'fire emoji (4-byte, surrogate pair)',
    '\u{1f525}',
    'ed8d830565bfcc5cb5b15e7deef7b6d07645d06597c8d17c7bdd49ad6f0e310a',
  ],
];

describe('sha256Hex', () => {
  it.each(VECTORS)('matches the published vector for a %#-byte input', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('produces 64 lowercase hex characters', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(UTF8_VECTORS)('matches the reference vector for %s', (_label, input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('encodes a lone surrogate as U+FFFD, matching TextEncoder', () => {
    // An unpaired surrogate has no UTF-8 encoding, so this is the one place two
    // conforming encoders could legitimately disagree -- and a disagreement would mean
    // the same string hashes differently on different hosts.
    expect(sha256Hex('a\ud800b')).toBe(sha256Hex('a�b'));
    expect(sha256Hex('a\ud800b')).toBe(
      '05087813392efc16fe8ff448920c6328e53af865df39419436659d9ffda90f7b',
    );
  });

  it('is not confused by the padding boundaries', () => {
    // 55 bytes fits the length in the final block; 56 forces another. A padding bug
    // shows up as these two colliding or as a vector above failing.
    const a = sha256Hex('a'.repeat(55));
    const b = sha256Hex('a'.repeat(56));
    expect(a).not.toBe(b);
    expect(sha256Hex('a'.repeat(63))).not.toBe(sha256Hex('a'.repeat(64)));
  });
});

describe('canonicalJson', () => {
  it('sorts keys, so authoring order does not change the serialization', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('is stable for nested objects and arrays', () => {
    const one = canonicalJson({ list: [{ z: 1, a: 2 }], name: 'x' });
    const two = canonicalJson({ name: 'x', list: [{ a: 2, z: 1 }] });
    expect(one).toBe(two);
  });

  it('drops undefined rather than serializing it', () => {
    // Under exactOptionalPropertyTypes an absent optional field and an explicit
    // undefined are different types -- but they must not be different specs.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('preserves the distinction between null, 0, false and ""', () => {
    const distinct = [null, 0, false, ''].map((value) => canonicalJson(value));
    expect(new Set(distinct).size).toBe(4);
  });

  it('cannot be fooled by content that looks like its own delimiters', () => {
    // The classic hand-rolled-serializer collision: joining with `key=value,` would
    // make these two structures identical text, and therefore the same hash. Keys and
    // values are JSON-encoded here precisely so this cannot happen -- if someone
    // "simplifies" canonicalJson to concatenate, this test fails before the collision
    // reaches a database.
    const nested = canonicalJson({ a: '1,"b":2' });
    const split = canonicalJson({ a: '1', b: 2 });
    expect(nested).not.toBe(split);
  });

  it('refuses non-finite numbers instead of emitting invalid JSON', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Infinity })).toThrow(/non-finite/);
  });

  it('refuses values that are not JSON', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/cannot canonically serialize/);
  });
});

describe('nonJsonReason', () => {
  /**
   * Every value here has one property in common: `canonicalJson` does not round-trip it.
   * The table says how each one fails rather than that each one fails, because the families
   * differ -- a `Date` serializes to `{}` WITHOUT throwing, which is why a `try`/`catch`
   * around the serializer was never going to find it (asc-bcv.12, B9).
   */
  const UNREPRESENTABLE: readonly (readonly [string, unknown, RegExp])[] = [
    // Silent: `canonicalJson` succeeds and the value is gone.
    ['a Date', new Date('2026-09-13T00:00:00Z'), /a Date/],
    ['a Map', new Map([['a', 1]]), /a Map/],
    ['a Set', new Set([1]), /a Set/],
    ['a RegExp', /x/g, /a RegExp/],
    // Loud, but only after validation has already said the entry is fine.
    ['NaN', Number.NaN, /NaN/],
    ['Infinity', Number.POSITIVE_INFINITY, /Infinity/],
    ['a bigint', 10n, /a bigint/],
    ['a function', () => 1, /a function/],
    ['a symbol', Symbol('s'), /a symbol/],
    ['undefined', undefined, /undefined/],
    // Not even loud: `canonicalJson` recurses until the stack overflows.
    [
      'a cycle',
      (() => {
        const c: Record<string, unknown> = { a: 1 };
        c['self'] = c;
        return c;
      })(),
      /a cycle/,
    ],
    // The same loss one step in: a member neither `Object.entries` nor a zod record walk lists.
    ['a symbol-keyed member', { a: 1, [Symbol('meta')]: 2 }, /a symbol-keyed member/],
    [
      'a non-enumerable member',
      Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false }),
      /a non-enumerable member/,
    ],
  ];

  it.each(UNREPRESENTABLE)('names %s', (_label, value, expected) => {
    expect(nonJsonReason(value)).toMatch(expected);
  });

  it('is not vacuous: every value it flags is one canonicalJson cannot round-trip', () => {
    // Without this, `nonJsonReason` returning `'a Date'` for EVERYTHING would pass the table
    // above. The witness is the serializer's own behaviour, and it had to be built twice:
    //
    //   - Comparing two canonical STRINGS reports agreement precisely where the value was lost,
    //     because `canonicalJson({v: date})` and `canonicalJson({v: {}})` are the same text.
    //   - Comparing the value and its round trip with a deep-equality helper reports agreement
    //     again, for the non-enumerable member: `toEqual` compares enumerable own keys, which is
    //     the same view that dropped it.
    //
    //   - Comparing the round trip to the original misses the `Map`, whose contents live in an
    //     internal slot rather than in own keys: `JSON.stringify(new Map([['a',1]]))` and
    //     `JSON.stringify({})` are both `{}`, and neither has an own key.
    //
    // So the witness asks three independent questions -- prototype, bytes, and own keys -- and
    // requires at least one of them to say the value did not survive. A witness that cannot see
    // a `Map` vanish cannot vouch for the check that is supposed to catch it.
    const survived = (before: unknown, after: unknown): boolean =>
      typeof before === 'object' &&
      before !== null &&
      Object.getPrototypeOf(before) === Object.getPrototypeOf(after) &&
      JSON.stringify(before) === JSON.stringify(after) &&
      Reflect.ownKeys(before).length === Reflect.ownKeys(after as object).length;

    for (const [label, value] of UNREPRESENTABLE) {
      let text: string;
      try {
        text = canonicalJson(value);
      } catch {
        continue; // Threw: unrepresentable, confirmed independently.
      }
      expect([label, survived(value, JSON.parse(text) as unknown)]).toEqual([label, false]);
    }
  });

  it('returns undefined for every value JSON can represent', () => {
    const REPRESENTABLE: readonly unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      1.5,
      'text',
      '',
      [],
      {},
      [1, 'two', null, { nested: [true, false] }],
      { list: [{ z: 1, a: 2 }], name: 'x' },
      // A null-prototype object, which is what `validateEntry` accumulates into.
      Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 }),
    ];

    for (const value of REPRESENTABLE) {
      const reason = nonJsonReason(value);
      expect(`${canonicalJson(value)} -> ${String(reason)}`).toBe(
        `${canonicalJson(value)} -> undefined`,
      );
    }
  });

  it('points at the offending member rather than at the whole value', () => {
    // A `json` property holding a large object: naming only the property sends the recorder
    // back to re-read all of it. The path is the difference between a usable error and a hunt.
    expect(nonJsonReason({ ok: [1, 2], bad: { when: new Date(0) } }, 'v')).toBe(
      'a Date at v.bad.when',
    );
    expect(nonJsonReason([1, new Date(0)], 'v')).toBe('a Date at v[1]');
    // At the root there is nothing to disambiguate, so the path is not repeated.
    expect(nonJsonReason(new Date(0), 'v')).toBe('a Date');
  });

  it('does not call a value repeated across siblings a cycle', () => {
    // A DAG is not a cycle: `canonicalJson` writes the shared value twice and round-trips it.
    const shared = { a: 1 };
    expect(nonJsonReason({ left: shared, right: shared })).toBeUndefined();
    expect(canonicalJson({ left: shared, right: shared })).toBe('{"left":{"a":1},"right":{"a":1}}');
  });

  it('refuses undefined, which canonicalJson DROPS inside an object', () => {
    // The one place the two deliberately disagree, so it is asserted rather than left implicit:
    // dropping is right for a type spec (`typeHash` must not see an absent optional field and an
    // explicit undefined as two definitions) and wrong for an entry property, where the property
    // would resolve `measured` and the key would not be in the row.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(nonJsonReason({ a: 1, b: undefined }, 'v')).toBe('undefined at v.b');
  });

  it('does not invoke a hostile constructor getter', () => {
    // `objectKind` reads `.constructor.name` to name the offender. That read runs on whatever a
    // caller offered, so a throwing getter must degrade to a message, not to a thrown error --
    // the whole point of this function is to turn a crash into a validation problem.
    const hostile = Object.create(
      Object.defineProperty({}, 'constructor', {
        get() {
          throw new Error('hostile');
        },
      }),
    ) as object;
    expect(nonJsonReason(hostile, 'v')).toBe('a non-plain object');
  });
});

describe('typeHash', () => {
  const base = canonicalizeTypeSpec({
    name: 'review_completed',
    properties: [
      { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
      { name: 'reviewer', type: 'ref' },
    ],
  }).spec;

  it('is stable across calls', () => {
    expect(typeHash(base)).toBe(typeHash(base));
  });

  it('ignores property ORDER, which is not part of a definition', () => {
    const reordered = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [
        { name: 'reviewer', type: 'ref' },
        { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
      ],
    }).spec;
    // Serialization sorts object keys but NOT array elements, so order-independence
    // has to come from canonicalizeTypeSpec sorting the properties. If that sort is
    // ever removed this fails -- which is the point, because the failure mode is two
    // spellings of one definition reporting as drift.
    expect(typeHash(reordered)).toBe(typeHash(base));
  });

  it('ignores the order of enum values, which are a set', () => {
    const one = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [{ name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] }],
    }).spec;
    const other = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [{ name: 'outcome', type: 'enum', enum_values: ['rejected', 'approved'] }],
    }).spec;
    expect(typeHash(one)).toBe(typeHash(other));
  });

  it('changes when a property type changes', () => {
    const retyped = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [
        { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
        { name: 'reviewer', type: 'string' },
      ],
    }).spec;
    expect(typeHash(retyped)).not.toBe(typeHash(base));
  });

  it('is equal for specs that differ only in the name they were written with', () => {
    // The payoff of hashing the CANONICAL spec: these are the same definition, and
    // treating them as different is precisely the drift this is meant to detect.
    const camel = canonicalizeTypeSpec({
      name: 'reviewCompleted',
      properties: [{ name: 'reviewKind', type: 'string' }],
    }).spec;
    const snake = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [{ name: 'review_kind', type: 'string' }],
    }).spec;
    expect(typeHash(camel)).toBe(typeHash(snake));
  });
});
