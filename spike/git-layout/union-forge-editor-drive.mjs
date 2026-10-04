/**
 * asc-kq2f: drive Forgejo's web conflict editor with a real browser, and report what it commits.
 *
 * Kept separate from `union-forge-editor.mjs` so the fixture/API half stays runnable without a
 * browser. This module is the arm under measurement.
 *
 * `executablePath` points at the system Chrome on purpose: `puppeteer-core` deliberately downloads
 * no browser, and the machine already has Chrome installed. Pinning the executable is also what
 * makes the arm reproducible without a network fetch.
 *
 * PRECONDITION: `puppeteer-core` is a devDependency of this repo, accepted explicitly into
 * `.align/baseline.json` for `security.manifest.new-dependency`. That is deliberate and is what the
 * rule is for: a new dependency should be a decision somebody made, not something that appeared.
 * It is a devDependency, so it never reaches a shipped artifact; the arm is checked in because
 * `EV-40.md` records the surface as ABSENT, and a future Forgejo may grow one — at which point this
 * is the thing that would notice.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** What the page offers to click -- so the arm is scripted against the real UI, not a guess at it. */
const describeControls = () =>
  [...document.querySelectorAll('button, a.button, input[type=submit], .ui.button')]
    .map((b) => ({
      tag: b.tagName.toLowerCase(),
      text: (b.innerText || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      href: b.getAttribute('href') ?? undefined,
      id: b.id || undefined,
      cls: b.className || undefined,
    }))
    .filter((c) => c.text !== '' || c.href !== undefined);

/**
 * Clicking by text, not by `[type="submit"]`. Forgejo's sign-in button carries NO `type` attribute:
 * the DOM property reads "submit" because that is a `<button>`'s default, but the attribute selector
 * matches nothing. Measured -- `$$eval('button[type="submit"]', b => b.length)` is 0 while
 * `[...document.querySelectorAll('button')].map(b => b.type)` lists two "submit" buttons.
 */
async function clickByText(page, scope, text) {
  const clicked = await page.evaluate(
    (scopeSel, wanted) => {
      const root = document.querySelector(scopeSel);
      if (!root) return `no ${scopeSel}`;
      const button = [...root.querySelectorAll('button, input[type=submit]')].find(
        (b) => (b.innerText || b.value || '').trim() === wanted,
      );
      if (!button) {
        return `no button "${wanted}" in ${scopeSel}; saw: ${[...root.querySelectorAll('button')]
          .map((b) => JSON.stringify(b.innerText.trim()))
          .join(', ')}`;
      }
      button.click();
      return null;
    },
    scope,
    text,
  );
  if (clicked !== null) throw new Error(clicked);
}

export async function driveEditor({ forge, owner, repo, pass, pull }) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);

    await page.goto(`${forge}/user/login`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[name="user_name"]');
    await page.type('input[name="user_name"]', owner);
    await page.type('input[name="password"]', pass);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      clickByText(page, 'form[action="/user/login"]', 'Sign in'),
    ]);
    console.log(`[drive] logged in as ${owner}, landed on ${page.url()}`);

    const url = `${forge}/${owner}/${repo}/pulls/${pull}/conflicts`;
    const response = await page.goto(url, { waitUntil: 'networkidle2' });
    const status = response?.status();
    console.log(`[drive] GET ${url} -> ${String(status)} (final ${page.url()})`);

    if (status === 404) {
      // Measured, not assumed: Forgejo 10.0.3 has no conflict editor. The PR page carries no
      // resolution control either, and the binary has no handler for one -- see EV-40.
      console.log('[drive] VERDICT: no web conflict editor at this route (404) — surface absent');
      return;
    }

    // If a future version does grow one, this is the recon that says what it offers. The arm is
    // scripted against what the page actually renders, never against a guess at its markup.
    console.log('\n[drive] --- page text (first 2000 chars) ---');
    console.log(await page.evaluate(() => document.body.innerText.slice(0, 2000)));
    console.log('\n[drive] --- controls ---');
    console.log(JSON.stringify(await page.evaluate(describeControls), null, 1));
    console.log('\n[drive] --- forms ---');
    console.log(
      JSON.stringify(
        await page.evaluate(() =>
          [...document.querySelectorAll('form')].map((f) => ({
            action: f.getAttribute('action'),
            method: f.method,
            fields: [...f.querySelectorAll('input, textarea')].map((i) => ({
              name: i.name,
              type: i.type,
              value: i.value?.slice(0, 80),
            })),
          })),
        ),
        null,
        1,
      ),
    );
    throw new Error(
      'a conflict editor responded -- this arm was written against its absence and must be ' +
        're-examined before its output is believed (see EV-40)',
    );
  } finally {
    await browser.close();
  }
}
