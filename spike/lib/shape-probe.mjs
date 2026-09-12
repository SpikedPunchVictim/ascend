// Aggregate schema discovery over the transcript corpus.
//
// Reports ONLY structural metadata: key names, value kinds, occurrence counts.
// No field VALUES are ever collected or printed, with two deliberate
// exceptions that are enumerations rather than content (a denial *kind*, a
// skill *name*) -- see spike-corpus.mjs, which handles those.
//
// Purpose: the spike must know the shape of `userFeedback`, `toolDenialKind`,
// `compactMetadata`, and `attributionSkill` before it can extract a corpus,
// and the shape must come from the data rather than from prose.

const MAX_KEYS_PER_OBJECT = 40;
const MAX_DEPTH = 4;

/** Structural signature of a value: a kind, or an object's sorted key list. */
function signature(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array<empty>';
    return `array<${signature(value[0], depth + 1)}>`;
  }
  const t = typeof value;
  if (t === 'object') {
    if (depth >= MAX_DEPTH) return 'object<…>';
    const keys = Object.keys(value).sort();
    const shown = keys.slice(0, MAX_KEYS_PER_OBJECT);
    const suffix = keys.length > shown.length ? ',…' : '';
    return `object{${shown.join(',')}${suffix}}`;
  }
  return t;
}

/** Walks a record, recording key paths and the signatures seen at each. */
export function collectShape(record, into, prefix = '', depth = 0) {
  if (record === null || typeof record !== 'object') return into;
  if (Array.isArray(record)) {
    for (const item of record.slice(0, 3)) collectShape(item, into, prefix, depth);
    return into;
  }
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    let entry = into.get(path);
    if (!entry) {
      entry = { count: 0, signatures: new Map() };
      into.set(path, entry);
    }
    entry.count += 1;
    const sig = signature(value, depth);
    entry.signatures.set(sig, (entry.signatures.get(sig) ?? 0) + 1);
    if (depth < MAX_DEPTH) collectShape(value, into, path, depth + 1);
  }
  return into;
}

/** Formats a shape map as a stable, printable report (no values). */
export function formatShape(shape, { minCount = 1, limit = 200 } = {}) {
  const rows = [...shape.entries()]
    .filter(([, v]) => v.count >= minCount)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit);
  return rows
    .map(([path, v]) => {
      const sigs = [...v.signatures.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([s, n]) => `${s}(${n})`)
        .join(' | ');
      return `${String(v.count).padStart(9)}  ${path}  ::  ${sigs}`;
    })
    .join('\n');
}
