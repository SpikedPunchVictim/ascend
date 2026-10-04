/**
 * asc-kq2f: does VS Code's own conflict-resolution path honour `merge=union`?
 *
 * The forge arm (`union-forge-editor.mjs`) found the web conflict editor absent. VS Code is the one
 * GUI client installed on this machine, so it is the one surface that can still be driven.
 *
 * **What VS Code does, read from the installed 1.139.0 rather than assumed** (the bundles are the
 * evidence; `extensions/git/dist/main.js`):
 *
 *   * `merge`, `mergeBranch`, `mergeAbort` all shell to the **`git` binary** (`git merge ...`), so
 *     they inherit `.gitattributes` -- the same path the command-line arm already measured clean on
 *     `base-union`.
 *   * `mergeFile` shells to **`git merge-file -p <in1> <base> <in2>`**, a standalone 3-way merge that
 *     never reads `.gitattributes`. That IS a real bypass -- but its only caller is `runGitMerge`,
 *     which returns early unless the active tab is a `TabInputTextMerge`, i.e. the Merge Editor is
 *     ALREADY open on a conflict. So it is reachable only after git has already conflicted.
 *
 * Both cells are therefore driven with the SAME instrument -- the merge-conflict extension's
 * "Accept All Current", the naive one-sided resolution -- and the difference between them is the
 * measurement:
 *
 *   * `plain` (no `.gitattributes`): git conflicts, VS Code resolves, and the appends are expected
 *     to be GONE. This is the control. Without it, a clean `union` result would be unfalsifiable --
 *     an instrument never observed detecting the failure is not evidence that it looked.
 *   * `union`: git merges clean, so VS Code has nothing to accept and the command must be a no-op.
 *
 * **Stated plainly, because it bounds the claim:** in the `union` cell the MERGE is performed by
 * command-line git -- deliberately, because that is the binary VS Code delegates to. What this cell
 * measures is that VS Code adds no conflict of its own on top of git's clean merge. It does not
 * exercise a VS Code merge path, because VS Code has none that runs before git does.
 *
 * Usage: node union-vscode-arm.mjs <seed-dir> --setup | --drive
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const SEED = process.argv[2];
const MODE = process.argv[3];
// Cells and profiles are rebuilt from scratch each run, so `setup` deletes this tree. The seed is
// therefore passed in from OUTSIDE it: an earlier spelling of this file used the seed's own parent
// as WORK and the `rmSync` destroyed the fixture before the first `cpSync` could read it.
const WORK = '/tmp/asc-kq2f-vscode/work';
const PORT = { plain: 9333, union: 9334 };

if (!SEED || !['--setup', '--drive'].includes(MODE)) {
  throw new Error('usage: node union-vscode-arm.mjs <seed-dir> --setup|--drive');
}
if (resolve(SEED).startsWith(resolve(WORK) + '/')) {
  throw new Error(`seed ${SEED} is inside WORK (${WORK}), which setup deletes -- move the seed out`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Read `records.jsonl` from DISK, never from the editor's report.
 *
 * `lines`, not `records`: a conflicted file is not JSONL, and counting its marker lines as records
 * would invent a number. What the loss claim actually rests on is `ra0`/`rb0` -- were both sides'
 * appends still there after the resolution? -- so those are reported by name.
 */
function assess(dir) {
  const text = readFileSync(`${dir}/records.jsonl`, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const unparseable = lines.filter((l) => {
    try {
      JSON.parse(l);
      return false;
    } catch {
      return true;
    }
  }).length;
  return {
    lines: lines.length,
    ra0: text.includes('"ra0"'),
    rb0: text.includes('"rb0"'),
    markers: text.includes('<<<<<<<'),
    unparseable,
  };
}

const describe = (s) =>
  `${String(s.lines)} lines, ra0 ${s.ra0 ? 'present' : 'ABSENT'}, ` +
  `rb0 ${s.rb0 ? 'present' : 'ABSENT'}, markers ${s.markers ? 'PRESENT' : 'none'}, ` +
  `unparseable lines ${String(s.unparseable)}`;

/**
 * Build both cells from the seed. Each is left in the state that VS Code is about to act on:
 * `plain` holding an unresolved conflict, `union` already merged clean by the git binary.
 */
function setup() {
  rmSync(WORK, { recursive: true, force: true });
  for (const cell of ['plain', 'union']) {
    cpSync(SEED, `${WORK}/${cell}`, { recursive: true });
    const dir = `${WORK}/${cell}`;
    try {
      git(dir, 'merge', '--abort');
    } catch {
      /* nothing to abort */
    }
    git(dir, 'reset', '--hard', '-q');
    git(dir, 'checkout', '-q', '-B', 'probe', `base-${cell}`);
    git(dir, 'merge', '-q', '--no-edit', `a-base-${cell}`);
    if (cell === 'union') {
      // The git binary honours the driver; this is the delegation VS Code inherits.
      git(dir, 'merge', '-q', '--no-edit', 'b-base-union');
    } else {
      try {
        git(dir, 'merge', '-q', '--no-edit', 'b-base-plain');
      } catch {
        /* the conflict is the point */
      }
    }
    const driver = git(dir, 'check-attr', 'merge', '--', 'records.jsonl').trim().split(': ').pop();
    const status = git(dir, 'status', '--short').trim() || '(clean)';
    console.log(`--- ${cell}: merge=${driver}, status=${status}`);
    console.log(`    before VS Code: ${describe(assess(dir))}`);
  }
}

async function connect(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`no CDP endpoint on ${String(port)}`);
}

/** Drive the command palette by keyboard -- the real UI path, not an internal API. */
async function runCommand(page, label) {
  await page.bringToFront();
  await page.keyboard.press('F1');
  await page.waitForSelector('.quick-input-widget', { timeout: 10000 });
  await page.keyboard.type(label, { delay: 20 });
  await sleep(600); // let the fuzzy filter settle before Enter picks a row
  const first = await page.evaluate(
    () => document.querySelector('.quick-input-list .monaco-list-row.focused')?.textContent ?? null,
  );
  await page.keyboard.press('Enter');
  await sleep(400);
  return first;
}

async function drive(cell) {
  const dir = `${WORK}/${cell}`;
  const port = PORT[cell];
  const child = spawn(
    CODE,
    [
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${WORK}/profile-${cell}`,
      `--extensions-dir=${WORK}/ext-${cell}`,
      '--skip-welcome',
      '--new-window',
      '--goto',
      `${dir}/records.jsonl`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  const before = assess(dir);
  let browser;
  try {
    browser = await connect(port);
    const page = (await browser.pages()).find((p) => p.url().includes('workbench'));
    if (!page) throw new Error('no workbench page');
    await sleep(4000); // let the workbench and the merge-conflict extension settle

    const chosen = await runCommand(page, 'Merge Conflict: Accept All Current');
    // `page.keyboard.press('Meta+s')` fails here: puppeteer-core 25's cdp `press` does not split a
    // '+'-joined chord, it hands the whole string to `down` and `assert`s on the lookup --
    // `Error: Unknown key: "Meta+s"`. `Meta` IS a defined key; the chord must be driven as three
    // calls. Same class as the Forgejo `[type="submit"]` note in EV-40: a plausible spelling that
    // silently means something else.
    await page.keyboard.down('Meta');
    await page.keyboard.press('s');
    await page.keyboard.up('Meta');
    await sleep(1500);
    await browser.disconnect();

    const after = assess(dir);
    console.log(`\n=== ${cell}`);
    console.log(`  palette chose : ${String(chosen).slice(0, 70)}`);
    console.log(`  before        : ${describe(before)}`);
    console.log(`  after         : ${describe(after)}`);
    return { cell, before, after, chosen };
  } finally {
    try {
      if (browser) await browser.disconnect();
    } catch {
      /* already gone */
    }
    // Detached spawn => the child leads its own process group; kill the group, not just the parent.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
  }
}

if (MODE === '--setup') {
  setup();
} else {
  const results = [];
  for (const cell of ['plain', 'union']) results.push(await drive(cell));
  console.log('\n=== summary (the claim is per-append survival, not a line delta)');
  for (const r of results) {
    const fate = (k) => (r.after[k] ? 'survived' : 'LOST');
    console.log(`  ${r.cell.padEnd(5)} ra0 ${fate('ra0')}, rb0 ${fate('rb0')}`);
  }
  await sleep(500);
}
