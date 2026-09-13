/**
 * Canonical serialization and `type_hash`.
 *
 * WHY A HASH AT ALL: each entry stores the `type_hash` of the definition it was
 * recorded against. That is what makes "did the schema drift under this data?"
 * answerable after the fact -- the direct fix for fold's confound #1, where the
 * schema moved while the rows stayed put and no one could tell which shape any
 * given row meant.
 *
 * WHY SHA-256 IMPLEMENTED HERE rather than `node:crypto`: core is pure -- zero
 * `fs`, zero network, zero Node builtins (TASKS.md non-negotiable #6, enforced by
 * ESLint and `align check`). Injecting a hasher was the alternative and was
 * rejected: a hash that depends on who computed it is not an identity, and this
 * value is compared across machines and across time.
 *
 * Collision resistance is not decoration here. If two different specs hashed equal,
 * entries recorded against one would silently be read as belonging to the other --
 * the exact class of defect this file exists to prevent.
 */

/** A value that survives a JSON round trip. */
export type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };

/** SHA-256 round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const INITIAL: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/**
 * Reads a word the loop bounds guarantee exists.
 *
 * `noUncheckedIndexedAccess` is on project-wide and it is load-bearing, so an indexed
 * read is `number | undefined` and cannot be used arithmetically. A `!` assertion is
 * banned by lint outside tests, and `?? 0` would be a silent wrong answer. This raises
 * instead: if a fixed-bound loop ever reads out of range, that is a bug worth hearing
 * about, not a zero to carry forward.
 */
function word(words: readonly number[], index: number): number {
  const value = words[index];
  if (value === undefined) throw new Error(`SHA-256 word index ${String(index)} out of range`);
  return value;
}

const rotr = (value: number, bits: number): number =>
  ((value >>> bits) | (value << (32 - bits))) >>> 0;

/**
 * UTF-8 bytes, encoded here rather than by the ambient `TextEncoder`.
 *
 * `TextEncoder` is a global, and core is pure: depending on the host to supply it
 * would make the hash depend on the runtime that computed it -- the same objection
 * that ruled out `node:crypto`. Writing the encoding down also makes it explicit, so
 * the bytes hashed for a given string are defined by this file rather than by
 * whatever global happens to be present.
 *
 * A lone surrogate encodes as U+FFFD, matching WHATWG's `TextEncoder`. That is the
 * one behaviour worth matching deliberately: an unpaired surrogate has no UTF-8
 * encoding at all, so two implementations that disagree here would produce different
 * hashes for the same JavaScript string on different hosts.
 */
function utf8(input: string): Uint8Array {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index++) {
    let code = input.charCodeAt(index);

    // A high surrogate followed by a low one is a single code point above the BMP.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
      const low = input.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }
    // Anything still in the surrogate range is unpaired.
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }

  return Uint8Array.from(bytes);
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  const bytes = utf8(input);
  const bitLength = bytes.length * 8;

  // Pad: 0x80, then zeros, so the total is 64-byte aligned with 8 bytes of length.
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;

  const lengthView = new DataView(message.buffer, message.byteOffset, message.byteLength);
  // 64-bit big-endian bit length, split so neither half overflows 32 bits.
  lengthView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  lengthView.setUint32(paddedLength - 4, bitLength % 0x100000000);

  const h = [...INITIAL];
  const w: number[] = new Array<number>(64).fill(0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = lengthView.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const x = word(w, i - 15);
      const y = word(w, i - 2);
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (word(w, i - 16) + s0 + word(w, i - 7) + s1) >>> 0;
    }

    let a = word(h, 0);
    let b = word(h, 1);
    let c = word(h, 2);
    let d = word(h, 3);
    let e = word(h, 4);
    let f = word(h, 5);
    let g = word(h, 6);
    let hh = word(h, 7);

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + word(K, i) + word(w, i)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (word(h, 0) + a) >>> 0;
    h[1] = (word(h, 1) + b) >>> 0;
    h[2] = (word(h, 2) + c) >>> 0;
    h[3] = (word(h, 3) + d) >>> 0;
    h[4] = (word(h, 4) + e) >>> 0;
    h[5] = (word(h, 5) + f) >>> 0;
    h[6] = (word(h, 6) + g) >>> 0;
    h[7] = (word(h, 7) + hh) >>> 0;
  }

  return h.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace.
 *
 * Key order must not affect the hash. Two specs that differ only in the order their
 * author happened to write the fields are the SAME definition, and if they hashed
 * differently every entry recorded against one would look like drift from the other.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cannot canonically serialize the non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` is dropped rather than serialized: under
      // exactOptionalPropertyTypes an absent optional field and an explicit
      // `undefined` are different types, but they must not be different specs.
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const body = entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',');
    return `{${body}}`;
  }
  throw new TypeError(`cannot canonically serialize a ${typeof value}`);
}

/**
 * Why `value` is not something JSON can represent, or `undefined` when it is.
 *
 * `canonicalJson` above answers "what bytes does this value have?". This answers the prior
 * question -- "does it have any, and is the value that comes back out the value that went in?"
 * Those are different questions, and only the second is the safety property an entry write needs.
 *
 * **Measured, before this existed** (`/tmp/probe-b9.mjs`, against the real store): a `Date`
 * offered for a `json` property validated `ok`, resolved to `measured`, and was stored as `{}`.
 * The row was indistinguishable from a genuinely empty object and the recorder was never told --
 * a fabricated measurement with ascend's own state column vouching for it. A `try`/`catch`
 * around `canonicalJson` cannot catch it, because a `Date` has no own enumerable properties and
 * so serializes successfully, as `{}`.
 *
 * Three families reach the ledger three different ways, and only one of them is loud:
 *
 * | offered                              | `canonicalJson`     | today                  |
 * |--------------------------------------|---------------------|------------------------|
 * | `Date`, `Map`, `Set`, `RegExp`, a    | silently `{}`       | recorded `measured`    |
 * | class instance                       |                     | holding `{}`           |
 * | `NaN`, `Infinity`, bigint, function, | throws a `TypeError`| recorded only AFTER   |
 * | symbol, `undefined` in an array      | naming the kind     | validation said `ok`   |
 * | a cycle                              | recurses until the  | a `RangeError` from    |
 * |                                      | stack overflows     | inside the serializer  |
 *
 * The rule is one rule -- a value JSON cannot represent -- stated once and applied to all three.
 *
 * **`undefined` is refused here but dropped by `canonicalJson`, deliberately.** Dropping it is
 * what makes `typeHash` treat an absent optional field and an explicit `undefined` as one
 * definition (see `canonicalJson` above), which is right for a spec. For an ENTRY property the
 * same drop is a silent loss: the property resolves `measured` and the key is not in the row. Two
 * contracts, two answers, and this paragraph is where the difference is decided rather than
 * inherited by accident.
 *
 * `path` is the label to name the offending value by -- the property name, for a caller checking
 * a property. The path of a nested offender is appended, so the message can point at the member
 * rather than at the whole value.
 */
export function nonJsonReason(value: unknown, path = ''): string | undefined {
  return walkJson(value, path, path, new Set<unknown>());
}

function walkJson(
  value: unknown,
  path: string,
  root: string,
  onPath: Set<unknown>,
): string | undefined {
  // Naming the root again would read as `'v' holds a Date at v`, so the location is only
  // spelled out once the walk has left the value the caller handed us.
  const at = path === root ? '' : ` at ${path}`;

  if (value === null) return undefined;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return undefined;
    case 'number':
      return Number.isFinite(value) ? undefined : `${String(value)}${at}`;
    case 'bigint':
      return `a bigint${at}`;
    case 'function':
      return `a function${at}`;
    case 'symbol':
      return `a symbol${at}`;
    case 'undefined':
      return `undefined${at}`;
    case 'object':
      break;
    default:
      return `a ${typeof value}${at}`;
  }

  // A value reachable from itself. `canonicalJson` does not detect this; it recurses until the
  // stack overflows, so the recorder sees a `RangeError` naming no value at all.
  if (onPath.has(value)) return `a cycle${at}`;
  onPath.add(value);

  try {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const problem = walkJson(item, `${path}[${String(index)}]`, root, onPath);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }

    const kind = objectKind(value);
    if (kind !== undefined) return `${kind}${at}`;

    // The same loss one step in: a member that is an own property but not an ENUMERABLE STRING
    // key is listed by neither `canonicalJson` (`Object.entries`) nor by zod's record walk, so a
    // member the recorder attached is silently absent from the row. `Reflect.ownKeys` sees both
    // kinds, and they are reported separately because they are dropped for different reasons --
    // JSON has no non-string key, and no enumeration-based writer visits a non-enumerable one.
    // Arrays returned above, which matters: an array's own `length` is non-enumerable.
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
      return `a symbol-keyed member${at}`;
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      return `a non-enumerable member${at}`;
    }

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const problem = walkJson(item, path === '' ? key : `${path}.${key}`, root, onPath);
      if (problem !== undefined) return problem;
    }
    return undefined;
  } finally {
    // Removed rather than left in place: a value appearing twice in a DAG is not a cycle, and
    // `canonicalJson` writes it twice without complaint. Only a value reachable from ITSELF is
    // the case it cannot survive.
    onPath.delete(value);
  }
}

/**
 * The noun for an object JSON cannot represent, or `undefined` for a plain one.
 *
 * Prototype identity, not `instanceof`: a `Date` from another realm fails `instanceof` but is
 * still a `Date`, and a class instance is exactly as unrepresentable as the built-ins are.
 */
function objectKind(value: object): string | undefined {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return undefined;

  let name: unknown;
  try {
    // Reading `constructor` invokes a getter when one is defined, and this runs on whatever a
    // caller offered -- so a hostile or merely careless object must not turn a validation error
    // into a thrown one.
    name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  } catch {
    return 'a non-plain object';
  }

  // `Object.create(somePrototype)` has no name to report and is still unrepresentable.
  return typeof name === 'string' && name !== '' && name !== 'Object'
    ? `a ${name}`
    : 'a non-plain object';
}

/**
 * The stable identity of a type definition.
 *
 * Callers must pass an ALREADY-CANONICALIZED spec (`canonicalizeTypeSpec`). Hashing a
 * raw spec would give `reviewKind` and `review_kind` different hashes, which is the
 * drift this is supposed to detect rather than reproduce.
 */
export function typeHash(canonicalSpec: unknown): string {
  return sha256Hex(canonicalJson(canonicalSpec));
}
