// asc-77b7 -- how many stored `#N` suffixes are the spurious cross-type ones, and do any of them
// need migrating?
//
// Read-only. Run from the repo root against the live store:  node spike/asc-77b7-suffix-namespace.mjs
//
// The question it answers is Step 6 check 3: "can records already exist that violate the fixed
// invariant?" The fix namespaces the deriver's `issued` set by type, so the invariant it restores is
// "no id carries a #N suffix unless the SAME type already holds the bare key". This counts the
// stored violations and, more usefully, their type VERSION -- because an id that is already at an
// older version than the current rule is one the version mechanism supersedes on its own, and needs
// no migration at all.
//
// It parses the entry files directly rather than going through the store, so it measures what is on
// disk rather than what the current code would write -- which is the whole point of asking about
// existing data.
//
// How many stored `#N` suffixes are the spurious cross-type ones asc-77b7 describes?
//
// A suffix is spurious when the SAME (session, tool_use) key is held by a DIFFERENT type without a
// suffix -- i.e. the second type was suffixed only because the first type had already taken the bare
// key. A suffix whose only other holder is the same type is the legitimate sibling-transcript case
// the deriver's docblock reasons about.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = '.ascend/entries';

/** id -> {type, version, session, key, suffix} for every derived claude-code entry. */
const ids = new Map();
for (const dir of readdirSync(root)) {
  const full = join(root, dir);
  if (!statSync(full).isDirectory()) continue;
  for (const file of readdirSync(full)) {
    for (const line of readFileSync(join(full, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry.id !== 'string') continue;
      const m = /^derived:claude-code:([a-z_]+)(?:@(\d+))?:(.*)$/.exec(entry.id);
      if (m === null) continue;
      const rest = m[3];
      const hash = /#(\d+)$/.exec(rest);
      const body = hash === null ? rest : rest.slice(0, -hash[0].length);
      const colon = body.indexOf(':');
      ids.set(entry.id, {
        type: m[1],
        version: m[2] ?? '1',
        session: body.slice(0, colon),
        key: body.slice(colon + 1),
        suffix: hash === null ? null : Number(hash[1]),
      });
    }
  }
}

/** (session, key) -> the ids that hold it. The namespace the deriver shares across types. */
const holders = new Map();
for (const [id, parts] of ids) {
  const k = `${parts.session}\u0000${parts.key}`;
  if (!holders.has(k)) holders.set(k, []);
  holders.get(k).push({ id, ...parts });
}

const suffixed = [...ids.values()].filter((p) => p.suffix !== null);
const spurious = [];
const legitimate = [];
for (const parts of suffixed) {
  const others = holders.get(`${parts.session}\u0000${parts.key}`);
  const otherTypes = new Set(
    others.filter((o) => o.id !== undefined && o.type !== parts.type).map((o) => o.type),
  );
  // Same type, same key, BARE -- the sibling-transcript case the docblock describes.
  const sameTypeBare = others.some((o) => o.type === parts.type && o.suffix === null);
  (otherTypes.size > 0 ? spurious : legitimate).push({ ...parts, otherTypes: [...otherTypes], sameTypeBare });
}

console.log(`derived claude-code entries           ${ids.size}`);
console.log(`distinct ids carrying a suffix        ${suffixed.length}`);
console.log(`  spurious (another TYPE holds the bare key)  ${spurious.length}`);
console.log(`  same-type only (the documented case)        ${legitimate.length}`);
console.log();
const currentVersions = { verification_run: 4, skill_activation: 2 };
for (const s of spurious) {
  const at = s.version === '1' ? 'v1 (bare, no @n in the id)' : `v${s.version}`;
  const now = currentVersions[s.type] ?? 1;
  console.log(
    `SPURIOUS  ${s.type}#${s.suffix}  ${at}  session=${s.session}  key=${s.key}\n` +
      `          bare key also held by: ${s.otherTypes.join(', ')}\n` +
      `          rule is now v${now} -> a re-ingest writes a DIFFERENT id for other reasons: ` +
      `${now !== Number(s.version)}`,
  );
}
console.log();
for (const l of legitimate) {
  console.log(`SAME-TYPE ${l.type}#${l.suffix}  session=${l.session}  key=${l.key}  bare-sibling=${l.sameTypeBare}`);
}
