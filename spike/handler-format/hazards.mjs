// Spike asc-6ola.5 (throwaway). Q6: does the strict loader refuse what it must, and does the
// canonical hash ignore formatting?
import { readFileSync } from 'node:fs';
import { load, compile } from './yaml-candidate.mjs';

const base = readFileSync(new URL('./a/bead-close.yaml', import.meta.url), 'utf8');
const cases = {
  'anchor + alias': 'on: command.run\nwhere: &w { ok: true }\nemit: { x: *w }',
  'merge key': 'on: command.run\nbase: { ok: true }\nwhere:\n  <<: { ok: true }\nemit: { x: a }',
  'explicit tag': 'on: command.run\nwhere: { head: !!str bd }\nemit: { x: a }',
  'number where a string is required (head: 1.10)': 'on: command.run\nwhere: { head: 1.10 }\nemit: { x: a }',
  'bool field given a word (ok: yes)': 'on: command.run\nwhere: { ok: yes }\nemit: { x: a }',
  'duplicate key': 'on: command.run\nwhere: { ok: true, ok: false }\nemit: { x: a }',
  'unknown key': 'on: command.run\nwher: { ok: true }\nemit: { x: a }',
  'unknown field': 'on: command.run\nwhere: { hed: bd }\nemit: { x: a }',
};
for (const [name, src] of Object.entries(cases)) {
  try { compile(load(src).spec); console.log(`ACCEPTED  ${name}`); }
  catch (err) { console.log(`refused   ${name}: ${err.message}`); }
}
const reformatted = `# same handler, other formatting
emit: {to_status: "complete", stage: "\${id}"}
each:
  as: id
  matches: "^[a-z]+-[a-z0-9]+(\\\\.[0-9]+)*$"
  from: 2
  field: argv
where: {argv.1: "close", head: 'bd', ok: true}
on: "command.run"
`;
const h0 = load(base).hash, h1 = load(reformatted).hash, h2 = load(base.replace('from: 2', 'from: 1')).hash;
console.log(`hash original     ${h0.slice(0, 16)}`);
console.log(`hash reformatted  ${h1.slice(0, 16)}  ${h0 === h1 ? 'EQUAL' : 'DIFFERENT'}`);
console.log(`hash one value    ${h2.slice(0, 16)}  ${h0 === h2 ? 'EQUAL' : 'DIFFERENT'}`);
