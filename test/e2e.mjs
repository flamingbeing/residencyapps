// Browser test of the app in demo mode at phone size, with an axe accessibility check on each screen.
// Run from the repo root (no server needed: files are served from this checkout through the Worker's own routes):
//   node test/e2e.mjs            SHOTS=<dir> also saves phone screenshots
// Needs Playwright (PLAYWRIGHT_PATH) and axe-core (AXE_PATH, or tools/vendor/axe.min.js); in CI a missing axe fails the run.
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright/index.mjs');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '../worker/routes.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const AXE = process.env.AXE_PATH || path.join(root, 'tools/vendor/axe.min.js');
if (!fs.existsSync(AXE) && process.env.CI) throw new Error('axe-core not found: set AXE_PATH');
const HOST = 'residencyapps.anawj.com';
const BASE = `https://${HOST}/`;
const SHOTS = process.env.SHOTS;
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', json: 'application/json', png: 'image/png', webmanifest: 'application/manifest+json' };

const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') && !fs.statSync('/opt/pw-browsers/chromium').isDirectory() ? '/opt/pw-browsers/chromium' : null);
const b = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {});
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', acceptDownloads: true });
const posted = [];
await ctx.route(new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/`), async route => {
  const u = new URL(route.request().url());
  const r = resolve(HOST, decodeURIComponent(u.pathname));
  if (r.redirect) return route.fulfill({ status: 301, headers: { Location: new URL(r.redirect, BASE).href } });
  if (!r.file && r.file !== '') return route.fulfill({ status: 404, body: 'not found' });
  const rel = r.file === '' || r.file.endsWith('/') ? r.file + 'index.html' : r.file;
  const f = path.join(root, rel);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: 'not found' });
  await route.fulfill({ status: 200, contentType: MIME[f.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync(f) });
});
// the Google Form and Firebase: never reached in the demo; anything sent there is recorded
await ctx.route(/^https:\/\/(docs\.google\.com|www\.gstatic\.com\/firebasejs)\//, route => { posted.push(route.request().url()); route.fulfill({ status: 200, body: '' }); });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });

const axe = async (label, pg = page) => {
  if (!fs.existsSync(AXE)) return;
  if (!(await pg.evaluate(() => !!window.axe))) await pg.addScriptTag({ path: AXE });
  await pg.waitForTimeout(300);
  const r = await pg.evaluate(() => window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }));
  const bad = r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  assert.equal(bad.length, 0, `axe (${label}): ` + bad.map(v => v.id + ' ' + v.nodes[0]?.target).join('; '));
};
const shot = async name => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
const tabs = async () => page.getByRole('tab').allTextContents();

// 0. Signed out: the passcode is the way in; Google is tucked away for admins
await page.goto(BASE + '?demo=reset');
await page.getByRole('button', { name: /Alex Demo/ }).waitFor();
await page.getByRole('button', { name: 'Account' }).click();
await page.getByRole('button', { name: 'Sign out' }).click();
await page.locator('#gp').waitFor();
assert.match(await page.textContent('main'), /passcode you were given/);
assert.ok(!(await page.getByRole('button', { name: 'Sign in with Google' }).isVisible()), 'Google sign-in sits under Admin sign-in');
await axe('sign-in'); await shot('0-sign-in');
await page.locator('#gp').fill('anything');
await page.getByRole('button', { name: 'Continue' }).click();

// 1. A guest: eight made-up applicants with passport-style photos, no staff tabs
await page.getByRole('button', { name: /Alex Demo/ }).waitFor();
assert.equal(await page.locator('.sl-grid .sl-tile').count(), 8);
assert.equal(await page.locator('.sl-grid img.sl-photo').count(), 8, 'every applicant has a photo');
assert.match(await page.textContent('main'), /Confidential/);
assert.deepEqual(await tabs(), [], 'a guest sees no Results or Set up');
await axe('home'); await shot('1-home');

// 2. Start goes straight to the first applicant; one tap scores, a comment is optional
await page.getByRole('button', { name: 'Start' }).click();
await page.getByText(/1 of 8/).waitFor();
await page.getByRole('radio', { name: '4' }).check({ force: true });
await page.fill('#q-comment', 'Calm during a difficult airway; asked for help early.');
await page.waitForTimeout(450);
await axe('applicant'); await shot('2-applicant');
const KEY = 'sel-demo-ans-demo-guest-demo-guest';
let saved = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
assert.equal(saved.a.a1.score, 4);

// 3. "I haven't worked with them" is one tap and moves on by itself; a score alone completes someone
await page.getByRole('button', { name: 'Next ›' }).click();
await page.getByText(/2 of 8/).waitFor();
await page.getByRole('button', { name: 'I haven’t worked with them' }).click();
await page.getByText(/3 of 8/).waitFor();
await page.getByRole('radio', { name: '3' }).check({ force: true });
await page.waitForTimeout(100);
saved = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
assert.equal(saved.a.a2.na, true);
assert.equal(saved.a.a3.score, 3);

// 4. Review flags only who still needs an answer; the name is optional (blank = Anonymous); one tap sends
await page.goto(BASE + '?demo#review');
await page.getByText('Worth a look (you can still send):').waitFor();
const review = await page.textContent('main');
assert.match(review, /3 of 8 answered/);
assert.match(review, /Dani Placeholder not answered yet/);
assert.equal(await page.inputValue('#sl-name'), '');
await axe('review'); await shot('3-review');
await page.getByRole('button', { name: 'Send', exact: true }).click();
await page.getByText('Sent. Thank you.').waitFor();
await axe('done');

// 4b. The app kit's look sits under Account (look A by default); picking Dark here keeps it on this device, so the
// screens from here on are checked in dark
assert.equal(await page.evaluate(() => document.documentElement.dataset.look), 'a', 'the app kit painted look A');
await page.getByRole('button', { name: 'Account' }).click();
await page.locator('dialog[open] summary', { hasText: 'Look on this device' }).click();
await page.locator('dialog[open] #theme-pick').selectOption('dark');
await axe('look'); await shot('4-look');
await page.getByRole('button', { name: 'Close' }).click();
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
await axe('done, dark'); await shot('4-done-dark');

// 5. An admin (Google sign-in) lands on the results: means, comments, CSV
await page.getByRole('button', { name: 'Account' }).click();
await page.locator('dialog[open] select').selectOption('admin');
await page.waitForLoadState('load');
await page.getByText(/5 responses/).waitFor();
assert.deepEqual(await tabs(), ['Results', 'Set up'], 'admins don’t answer');
assert.match(await page.textContent('main'), /4\.5 \(4\)/, 'Alex Demo: 5, 4, 5 and 4');
await page.getByRole('button', { name: /Alex Demo/ }).click();
assert.match(await page.textContent('main'), /Calm during a difficult airway[\s\S]*Anonymous/);
await axe('results'); await shot('4-results');
const dl = page.waitForEvent('download');
await page.getByRole('button', { name: 'Download CSV' }).click();
const csv = fs.readFileSync(await (await dl).path(), 'utf8');
assert.match(csv, /Alex Demo,Anonymous,[^,]+,Overall suitability for residency,4/);

// 6. Set up opens locked; photos, questions and dates
await page.getByRole('tab', { name: 'Set up' }).click();
await page.getByText(/Locked: nothing here can change/).waitFor();
assert.ok(await page.locator('#su-title').isDisabled(), 'the title is locked');
assert.ok(await page.locator('#pc-show').isEnabled(), 'Show stays available');
assert.match(await page.textContent('main'), /Selection committee[\s\S]*After the selection[\s\S]*Sign-in passcodes/);
assert.doesNotMatch(await page.textContent('main'), /People|Applicants set-up/, 'no APMES access list');
await axe('setup locked'); await shot('5-setup-locked');
await page.getByRole('button', { name: 'Unlock to edit' }).click();
const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 500; const x = c.getContext('2d'); x.fillStyle = '#3a8'; x.fillRect(0, 0, 600, 500); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Change photo for Alex Demo' }).click()]);
await chooser.setFiles({ name: 'whatever.png', mimeType: 'image/png', buffer: png });
await page.getByText(/1 photo added/).waitFor();
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sel-demo-store')).photos['demo|a1']);
const dim = await page.evaluate(src => new Promise(r => { const i = new Image(); i.onload = () => r([i.width, i.height]); i.src = src; }), stored);
assert.deepEqual(dim, [210, 270], 'cropped to a passport-shaped 7:9 picture');
await page.setInputFiles('#ph-many', [{ name: 'Bao-Sample.png', mimeType: 'image/png', buffer: png }, { name: 'IMG_0001.png', mimeType: 'image/png', buffer: png }]);
await page.getByText(/1 photo added\. Not used: IMG_0001\.png/).waitFor();
await page.getByRole('button', { name: 'Add a question' }).click();
await page.fill('input[aria-label="Question 3 text"]', 'Teamwork on the ward');
// a close before the open is refused
await page.fill('#su-opens', '2030-05-02T09:00');
await page.fill('#su-closes', '2030-05-01T09:00');
await page.getByRole('button', { name: 'Save changes' }).click();
await page.getByText('The round must close after it opens.').waitFor();
// closed by date: the guest can look but not send
await page.fill('#su-opens', '');
await page.fill('#su-closes', '2020-01-01T09:00');
await axe('setup unlocked'); await shot('6-setup');
await page.getByRole('button', { name: 'Save changes' }).click();
await page.getByText('Saved and published').waitFor();
await page.getByText(/Locked: nothing here can change/).waitFor();
assert.equal(await page.evaluate(() => typeof JSON.parse(localStorage.getItem('sel-demo-store')).rounds.demo.closesAt), 'number');
await page.goto(BASE + '?demo=guest#review');
await page.getByText(/This round has closed/).first().waitFor();
assert.ok(await page.getByRole('button', { name: /^Send/ }).isDisabled());
await page.goto(BASE + '?demo=guest#a/a1');
await page.getByText('Teamwork on the ward').waitFor();
// not open yet
await page.goto(BASE + '?demo=admin#setup');
await page.getByRole('button', { name: 'Unlock to edit' }).click();
await page.fill('#su-closes', '');
await page.fill('#su-opens', '2099-01-01T09:00');
await page.getByRole('button', { name: 'Save changes' }).click();
await page.getByText('Saved and published').waitFor();
await page.goto(BASE + '?demo=guest');
await page.getByText(/This round opens on 1 Jan 2099/).waitFor();
// closed by hand
await page.goto(BASE + '?demo=admin#setup');
await page.getByRole('button', { name: 'Unlock to edit' }).click();
await page.fill('#su-opens', '');
await page.getByRole('button', { name: 'Close the round' }).click();
await page.getByText('Closed').first().waitFor();
await page.goto(BASE + '?demo=guest#review');
await page.getByText(/This round is closed/).first().waitFor();
assert.ok(await page.getByRole('button', { name: /^Send/ }).isDisabled());

// 7. Passcodes: admins see and change them; each must differ
await page.goto(BASE + '?demo=admin#setup');
await page.locator('#pc-show').waitFor();
await page.getByRole('button', { name: 'Unlock to edit' }).click();
await page.locator('#pc-change-guest').click();
assert.match(await page.inputValue('#pc-guest'), /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/, 'a random passcode is suggested');
await page.fill('#pc-guest', 'Maple Tree 42');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByRole('button', { name: 'Change', exact: true }).last().click();   // the confirmation dialog
await page.getByText('Guest passcode changed').waitFor();
await page.locator('#pc-change-committee').click();
await page.fill('#pc-committee', ' maple tree 42 ');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByText(/already the guest passcode/).waitFor();
await axe('setup passcodes');

// 8. The set-up passcode: Set up only (no results, committee, passcodes or delete); the committee passcode: results only
await page.goto(BASE + '?demo=setup');
await page.getByText(/Locked: nothing here can change/).waitFor();
assert.deepEqual(await tabs(), ['Set up']);
assert.doesNotMatch(await page.textContent('main'), /Selection committee|Sign-in passcodes|After the selection/);
await page.goto(BASE + '?demo=setup#results');
await page.getByText(/Locked: nothing here can change/).waitFor();
await page.goto(BASE + '?demo=committee');
await page.getByText(/5 responses/).waitFor();
assert.deepEqual(await tabs(), ['Results']);
await page.goto(BASE + '?demo=committee#setup');
await page.getByText(/5 responses/).waitFor();

// 9. The retention delete: typed confirm, then every answer and photo goes
await page.goto(BASE + '?demo=admin#setup');
await page.getByRole('button', { name: 'Unlock to edit' }).click();
await page.getByRole('button', { name: 'Delete answers and photos' }).click();
await page.getByText('Type demo to confirm.').first().waitFor();
await page.fill('#rt-confirm', 'demo');
await page.getByRole('button', { name: 'Delete answers and photos' }).click();
await page.getByRole('button', { name: 'Delete', exact: true }).click();
await page.getByText(/Deleted 5 responses and 8 photos/).waitFor();
const left = await page.evaluate(() => JSON.parse(localStorage.getItem('sel-demo-store')));
assert.equal(Object.keys(left.responses).length, 0);
assert.equal(Object.keys(left.photos).length, 0);
assert.equal(left.rounds.demo.status, 'closed', 'the round stays, closed');

// 10. A round that isn't published (a private link), opened by a guest
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('sel-demo')) localStorage.removeItem(k); localStorage.setItem('sel-demo-store', JSON.stringify({ seeded: true })); });
await page.goto(BASE + '?demo=admin#setup');
await page.getByRole('button', { name: 'Unlock to edit' }).click();
await page.fill('#su-names', '1. Zoë Tan\n2. Lee Wei\nZoë Tan');
await page.fill('#su-title', 'Test round');
await page.getByRole('button', { name: 'Make a private link' }).click();
const link = await page.locator('textarea[aria-label="Private link"]').inputValue();
assert.match(link, /#r=/);
const other = await ctx.newPage();
other.on('pageerror', e => errors.push(String(e)));
await other.goto(BASE + '?demo=guest' + link.slice(link.indexOf('#')));
await other.getByRole('button', { name: /Zoë Tan/ }).waitFor();
assert.equal(await other.locator('.sl-grid .sl-tile').count(), 2, 'repeated names are dropped');
await other.close();

// 11. Back with tabs (the kit's tabBack): switching tabs adds at most one Back step; Back goes to the first tab, then leaves
const nav = await ctx.newPage();
nav.on('pageerror', e => errors.push(String(e)));
await nav.goto('about:blank');
await nav.goto(BASE + '?demo=admin');
await nav.getByRole('tab', { name: 'Results', selected: true }).waitFor();
await nav.waitForFunction(() => !!document.querySelector('[role=tab]'));
const len0 = await nav.evaluate(() => history.length);
for (const t of ['Set up', 'Results', 'Set up', 'Results', 'Set up']) {
  await nav.getByRole('tab', { name: t }).click();
  await nav.getByRole('tab', { name: t, selected: true }).waitFor();
}
assert.ok(await nav.evaluate(() => history.length) - len0 <= 1, 'tabs add at most one Back step');
await nav.goBack();
await nav.getByRole('tab', { name: 'Results', selected: true }).waitFor();
await nav.goBack();
assert.equal(nav.url(), 'about:blank', 'Back on the first tab leaves the app');
await nav.close();

assert.deepEqual(posted, [], 'the demo never reaches the Form or Firebase');
assert.deepEqual(errors, []);
await b.close();
console.log('applicants e2e: passed');
