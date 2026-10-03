/**
 * Spike asc-igg8 / Q3 — do concurrent appends to one file interleave?
 *
 * The exposure addendum (`spike/exposure/FINDINGS.md:125`) declares this "Unmeasured", and it is the
 * failure that makes a live log *quietly* wrong: two hook invocations appending at once, one line split
 * across two `write()` calls, and the result is JSONL that parses as garbage rather than failing loudly.
 *
 * The proposed mechanism is an async shell `>>` append (5.65 ms/event, against 71.8 ms for a node
 * appender and 184 ms for the asc CLI). `>>` opens O_APPEND, so each `write()` is placed atomically at
 * the end -- but a payload larger than the writer's buffer takes SEVERAL `write()` calls, and that is the
 * window another process lands in. So the question is not "does O_APPEND tear" but "how many write()
 * calls does the writer make". Three writer styles separate the two:
 *
 *   single  -- one writeSync of the whole payload (the best case; is ONE write() atomic?)
 *   chunk   -- writeSync in 64 KiB pieces (what a buffered writer / large shell printf does)
 *   cat     -- `cat >> file` with the payload on stdin: the literal mechanism the bead proposes
 *   byte    -- one byte per write (the pathological floor; proves the detector works)
 *
 * Every line is written at a known exact byte length and carries its own trailer, so a torn line is
 * detectable by length AND content, and no payload is ever printed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = 8;
const SIZES = [1024, 8192, 65536, 262144, 1048576];
const MODES = ['single', 'chunk', 'cat', 'byte'];
const REPEATS = 3;
/**
 * `byte` exists only to prove the detector fires, and one syscall per byte at 1 MiB is 32M syscalls
 * per run -- the first attempt of this probe was killed at 600s having produced no output at all. It
 * is capped at 8 KiB, which is enough to show the mechanism and cheap enough to finish.
 */
const BYTE_MAX = 8192;

const dir = mkdtempSync(join(tmpdir(), 'asc-append-race-'));
const results = [];

// One appender, driven by `node appender.mjs <file> <tag> <size> <k> <mode>`.
const APPENDER = `
import { openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
const [file, tag, size, k, mode] = process.argv.slice(2);
const n = Number(size), count = Number(k);
let buf = '';
for (let i = 0; i < count; i += 1) buf += ('L' + tag + ':' + i + ':').padEnd(n - 4, 'x') + ':END\\n';
const payload = Buffer.from(buf, 'utf8');
const fd = openSync(file, 'a');
if (mode === 'single') {
  writeSync(fd, payload);
} else if (mode === 'chunk') {
  for (let off = 0; off < payload.length; off += 65536) writeSync(fd, payload, off, Math.min(65536, payload.length - off));
} else {
  for (let off = 0; off < payload.length; off += 1) writeSync(fd, payload, off, 1);
}
closeSync(fd);
`;
const appenderPath = join(dir, 'appender.mjs');
writeFileSync(appenderPath, APPENDER);

function runOnce(size, mode) {
  const file = join(dir, `race-${size}-${mode}.jsonl`);
  writeFileSync(file, '');
  const k = Math.max(4, Math.min(40, Math.floor(1_048_576 / size)));
  const children = [];
  for (let p = 0; p < N; p += 1) {
    let child;
    if (mode === 'cat') {
      // The literal proposed mechanism: an async shell append with the payload on stdin.
      child = spawn('sh', ['-c', `cat >> "${file}"`], { stdio: ['pipe', 'ignore', 'ignore'] });
      let buf = '';
      for (let i = 0; i < k; i += 1) buf += `L${p}:${i}:`.padEnd(size - 4, 'x') + ':END\n';
      child.stdin.end(Buffer.from(buf, 'utf8'));
    } else {
      child = spawn(process.execPath, [appenderPath, file, String(p), String(size), String(k), mode], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }
    children.push(new Promise((resolve) => child.on('close', resolve)));
  }
  return Promise.all(children).then(() => {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l !== '');
    let torn = 0;
    for (const l of lines) if (l.length !== size || !l.endsWith(':END')) torn += 1;
    results.push({ size, mode, lines: lines.length, expected: N * k, torn });
    rmSync(file, { force: true });
    return null;
  });
}

console.log(`N=${N} concurrent appenders, ${REPEATS} repeats per cell\n`);

for (const mode of MODES) {
  for (const size of SIZES) {
    if (mode === 'byte' && size > BYTE_MAX) continue;
    for (let r = 0; r < REPEATS; r += 1) await runOnce(size, mode);
  }
}

console.log('mode      line size   runs   lines/expected      torn');
for (const mode of MODES) {
  for (const size of SIZES) {
    if (mode === 'byte' && size > BYTE_MAX) continue;
    const rows = results.filter((x) => x.mode === mode && x.size === size);
    const torn = rows.reduce((n, x) => n + x.torn, 0);
    const intact = rows.filter((x) => x.torn === 0).length;
    const lines = rows.map((x) => `${x.lines}/${x.expected}`).join(' ');
    console.log(
      `${mode.padEnd(8)}${String(size).padStart(10)}${String(rows.length).padStart(7)}   ${lines.padEnd(22)}${String(torn).padStart(5)}   ${intact}/${rows.length} intact`,
    );
  }
}

console.log('');
for (const mode of MODES) {
  const rows = results.filter((x) => x.mode === mode);
  const torn = rows.reduce((n, x) => n + x.torn, 0);
  const first = SIZES.find((s) => rows.some((x) => x.size === s && x.torn > 0));
  console.log(
    `${mode.padEnd(8)} ${String(torn).padStart(6)} torn line(s) total; ` +
      (first === undefined ? 'no tearing at any size tested' : `first tears at ${first} B (${(first / 1024).toFixed(0)} KiB)`),
  );
}

rmSync(dir, { recursive: true, force: true });
