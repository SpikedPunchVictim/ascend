import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const [src, dir, ext] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
for (const m of readFileSync(src, 'utf8').matchAll(/```\w*\n([\s\S]*?)```/g)) {
  const name = m[1].match(/^(?:#|--)\s*([a-z-]+)/)[1];
  writeFileSync(`${dir}/${name}.${ext}`, m[1]);
  console.log(dir, name);
}
