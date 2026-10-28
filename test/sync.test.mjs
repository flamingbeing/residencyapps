// Sending answers through app-sync (applicants/js/sync.js) against a made-up Firestore, and the exact pins of the sync
// engine and the update module (sw.js, cloud.js, app-update.js). The engine is the real one: its pinned files are
// fetched once from core.anawj.com into a temporary folder (APP_SYNC_DIR=<an app-sync checkout> uses that instead).
// Run: node --test test/sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'applicants');
const read = f => fs.readFileSync(path.join(APP, f), 'utf8');
const SYNC_VERSION = read('js/cloud.js').match(/core\.anawj\.com\/sync\/(\d+\.\d+\.\d+)\//)[1];
const UPDATE_VERSION = read('js/app-update.js').match(/core\.anawj\.com\/update\/(\d+\.\d+\.\d+)\//)[1];
// what the app loads: index.js and the app, auth and sync modules (entries.json lists each one's files)
const ENTRIES = ['app', 'auth', 'sync'];
const FILES = await (async () => {
  if (process.env.APP_SYNC_DIR) return [];
  const res = await fetch(`https://core.anawj.com/sync/${SYNC_VERSION}/entries.json`);
  assert.equal(res.status, 200, 'fetch entries.json');
  const entries = await res.json();
  const index = (await (await fetch(`https://core.anawj.com/sync/${SYNC_VERSION}/files.json`)).json());
  return [...new Set([...(Array.isArray(index) ? index : index.files), ...ENTRIES.flatMap(e => entries[e])])].sort();
})();

async function engine() {
  let dir = process.env.APP_SYNC_DIR;
  if (!dir) {
    dir = path.join(os.tmpdir(), 'residencyapps-app-sync-' + SYNC_VERSION);
    for (const f of FILES) {
      const to = path.join(dir, f);
      if (fs.existsSync(to)) continue;
      const res = await fetch(`https://core.anawj.com/sync/${SYNC_VERSION}/${f}`);
      assert.equal(res.status, 200, `fetch ${f}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, await res.text());
    }
  }
  const load = f => import(pathToFileURL(path.join(dir, f)).href);
  const [AS, { createApp }, { auth }, { sync }] = await Promise.all(['index.js', 'app.js', 'auth.js', 'sync.js'].map(load));
  return { AS, createApp, auth, sync };
}

// ---- a made-up Firestore: documents in a Map, transactions that fail as the network or the rules say ----
function fakeFirestore() {
  const docs = new Map();
  const server = { mode: 'up', terminated: false, cleared: false, docs };   // mode: up | down | deny
  const fail = code => { const e = new Error(code); e.code = code; return e; };
  const F = {
    collection: (_db, ...segs) => ({ path: segs.join('/') }),
    doc: (col, id) => ({ path: col.path + '/' + id, id }),
    serverTimestamp: () => ({ __server: true }),
    async runTransaction(_db, fn) {
      if (server.mode === 'down') throw fail('unavailable');
      const writes = [];
      const tx = {
        async get(ref) { const d = docs.get(ref.path); return { exists: () => !!d, data: () => d && JSON.parse(JSON.stringify(d)), id: ref.id }; },
        set(ref, data) { writes.push([ref.path, data]); },
        delete(ref) { writes.push([ref.path, null]); },
      };
      const out = await fn(tx);
      if (server.mode === 'deny') throw fail('permission-denied');
      for (const [p, d] of writes) d ? docs.set(p, d) : docs.delete(p);
      return out;
    },
    async terminate() { server.terminated = true; },
    async clearIndexedDbPersistence() { server.cleared = true; },
  };
  return { F, db: {}, server };
}
// the outbox in memory (the browser's is IndexedDB)
function memoryOutbox() {
  const m = new Map();
  const copy = v => JSON.parse(JSON.stringify(v));
  return {
    async put(x) { m.set(x.key, copy(x)); }, async list(owner) { return [...m.values()].filter(x => x.owner === owner).map(copy); },
    async get(k) { return m.has(k) ? copy(m.get(k)) : undefined; }, async remove(k) { m.delete(k); },
    async forget(owner) { for (const [k, x] of m) if (!owner || x.owner === owner) m.delete(k); }, size: () => m.size,
  };
}
const core = await engine();
const { createSaving, KIND } = await import(pathToFileURL(path.join(APP, 'js/sync.js')).href);
const ME = 'guest-u1';
const answer = (name = 'Anonymous', id = ME) => ({ id, email: id, name, answers: { a1: { score: 4, comment: 'Kind.' } } });
// made-up Firebase Auth: a passcode's custom token 'tok-<uid>' signs in that uid (no email), as the Worker's do
function fakeAuth() {
  const auth = { currentUser: null };
  const subs = new Set();
  const tell = () => { for (const cb of subs) cb(auth.currentUser); };
  const A = {
    onAuthStateChanged(_auth, cb) { subs.add(cb); queueMicrotask(() => cb(auth.currentUser)); return () => subs.delete(cb); },
    async signInWithCustomToken(_auth, t) { auth.currentUser = { uid: t.replace(/^tok-/, ''), email: null, isAnonymous: false }; tell(); },
    async signOut() { auth.currentUser = null; tell(); },
  };
  return { A, auth };
}
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };
async function setup({ persisted = true } = {}) {
  const f = fakeFirestore(), outbox = memoryOutbox(), { A, auth } = fakeAuth();
  let up = true;
  const base = { A, F: f.F, auth, db: f.db };
  const s = await createSaving({ core, sdk: async () => base, store: outbox, storage: null, online: () => up, persist: async () => ({ supported: true, persisted }), openDb: async () => f.db });
  const users = [];
  s.onUser(u => users.push(u));
  assert.deepEqual(await s.signIn({ method: 'token', code: 'tok-u1' }), { ok: true, reason: '' });
  await waitFor(() => users.at(-1)?.uid === 'u1');
  return { s, f, outbox, users, offline: v => { up = !v; f.server.mode = v ? 'down' : 'up'; } };
}
test('the engine and the update module are pinned to one exact version everywhere', () => {
  assert.equal(SYNC_VERSION, '1.5.2');
  assert.equal(UPDATE_VERSION, '1.5.2');
  assert.ok(FILES.length > 20 || process.env.APP_SYNC_DIR, 'the module files are listed');
  const sw = read('sw.js');
  for (const f of FILES) assert.ok(sw.includes(`'https://core.anawj.com/sync/${SYNC_VERSION}/${f}'`), `sw.js SHELL has sync ${f}`);
  assert.ok(sw.includes(`'https://core.anawj.com/update/${UPDATE_VERSION}/register.js'`), 'sw.js SHELL has register.js');
  assert.ok(sw.includes(`importScripts('https://core.anawj.com/update/${UPDATE_VERSION}/sw-core.js')`), 'sw.js uses sw-core at the same version');
  assert.match(sw, /waitForGo: true/, 'a new version waits for the page’s go');
  assert.doesNotMatch(sw + read('js/cloud.js') + read('js/app-update.js'), /'https:\/\/core\.anawj\.com\/(sync|update)\/(?!\d+\.\d+\.\d+\/)/, 'no moving address');
  assert.equal(new Set([...(sw + read('js/cloud.js')).matchAll(/core\.anawj\.com\/sync\/(\d+\.\d+\.\d+)\//g)].map(m => m[1])).size, 1, 'one sync version');
});

test('the app kit (app-ui) is pinned to one exact version and kept offline', () => {
  const sw = read('sw.js'), page = read('index.html') + read('js/ui.js');
  const versions = new Set([...(sw + page).matchAll(/core\.anawj\.com\/ui\/([^/'"]+)\//g)].map(m => m[1]));
  assert.deepEqual([...versions], ['1.0.0-rc.27'], 'one ui version');
  for (const f of ['theme/early.js', 'theme/theme.css', 'theme/index.js', 'theme/switch.js', 'theme/looks/a.js', 'theme/looks/e.js'])
    assert.ok(sw.includes(`'https://core.anawj.com/ui/1.0.0-rc.27/${f}'`), `sw.js SHELL has ui ${f}`);
  assert.doesNotMatch(sw + page, /core\.anawj\.com\/ui\/[^/]+\/(theme\/glass|ui\/layout)\.css/, 'the NUHS kit draws the bars and screens: no app-kit glass or layout sheet');
  assert.match(sw, /\(sync\|update\|ui\)/, 'the pinned rule covers the kit');
});

test('an answer sent online reaches the server with both stamps, and the status says synced once the server is heard', async () => {
  const { s, f } = await setup();
  assert.equal(s.status().state, 'unknown', 'not synced on the device’s word alone');
  assert.deepEqual(await s.send('2027', answer('Dr A')), { state: 'sent' });
  const doc = f.server.docs.get('selection/2027/responses/' + ME);
  assert.equal(doc.name, 'Dr A');
  assert.equal(typeof doc.updatedAt, 'number');
  assert.deepEqual(doc.serverAt, { __server: true }, 'serverAt is the server’s time (the rules check it)');
  assert.deepEqual(Object.keys(doc).sort(), ['answers', 'email', 'id', 'name', 'serverAt', 'updatedAt']);
  s.heard();
  assert.equal(s.status().state, 'synced');
  assert.equal(s.canReload(), true);
});

test('an answer sent offline is kept on the device, holds the reload and the sign-out, and goes by itself when back', async () => {
  const { s, f, outbox, offline } = await setup();
  s.heard();
  offline(true);
  assert.deepEqual(await s.send('2027', answer(), 300), { state: 'waiting' });
  assert.equal(outbox.size(), 1, 'in the outbox (survives a reload)');
  assert.equal(s.status().state, 'offline');
  assert.equal(s.canReload(), false, 'no update reload while an answer waits');
  assert.deepEqual(await s.signOut(), { ok: false, unsent: true }, 'sign-out refused while an answer is unsent');
  assert.equal(f.server.cleared, false, 'nothing wiped');
  offline(false);
  s.queue.kick();
  await waitFor(() => f.server.docs.has('selection/2027/responses/' + ME));
  await waitFor(() => s.status().state === 'synced');
  assert.deepEqual(await s.signOut(), { ok: true });
  assert.equal(f.server.terminated && f.server.cleared, true, 'forget cleared the SDK’s offline copy');
  assert.equal(outbox.size(), 0, 'and the outbox');
});

test('an answer the rules refuse (round closed) throws, is set aside, and nothing is left pending', async () => {
  const { s, f } = await setup();
  f.server.mode = 'deny';
  await assert.rejects(s.send('2027', answer()), e => e.code === 'permission-denied' || /permission/i.test(e.message));
  assert.equal(s.queue.pending(), 0);
  s.heard();
  assert.equal(s.status().state, 'synced', 'no lasting attention: the answers stay on the device for another try');
  assert.equal(f.server.docs.size, 0);
});

test('a write sent straight to the SDK counts as unsent until it settles (track)', async () => {
  const { s } = await setup();
  s.heard();
  let done;
  s.track(new Promise(r => { done = r; }));
  assert.equal(s.status().state, 'saving');
  assert.equal(s.canReload(), false);
  assert.deepEqual(await s.signOut(), { ok: false, unsent: true });
  done();
  await waitFor(() => s.status().state === 'synced');
  assert.deepEqual(await s.signOut(), { ok: true });
});

test('sign-out anyway (force) wipes the unsent answer; at-risk only while offline', async () => {
  const { s, outbox, offline } = await setup({ persisted: false });
  s.heard();
  let hold;
  s.track(new Promise(r => { hold = r; }));
  assert.equal(s.status().state, 'saving', 'online: not at-risk although storage is not kept (atRiskOnlyOffline)');
  hold();
  offline(true);
  await s.send('2027', answer(), 200);
  assert.equal(s.status().state, 'at-risk', 'offline with storage the browser may clear');
  assert.deepEqual(await s.signOut({ force: true }), { ok: true });
  assert.equal(outbox.size(), 0);
  assert.equal(KIND('2027'), 'responses@2027');
});

test('a new passcode on a device whose last guest left an answer unsent is refused, nothing wiped; it goes once sent', async () => {
  const { s, f, outbox, users, offline } = await setup();
  offline(true);
  assert.deepEqual(await s.send('2027', answer(), 200), { state: 'waiting' });
  // the next guest (a new uid) signs in on the same device
  const r = await s.signIn({ method: 'token', code: 'tok-u2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsent');
  assert.equal(s.blocked()?.reason, 'unsent');
  assert.equal(users.at(-1), null, 'nobody signed in');
  assert.equal(outbox.size(), 1, 'the first guest’s answer is still here');
  assert.equal(f.server.cleared, false);
  // the first guest comes back with signal: it sends, then the next guest is let in and the device wiped first
  offline(false);
  assert.deepEqual(await s.signIn({ method: 'token', code: 'tok-u1' }), { ok: true, reason: '' });
  await waitFor(() => f.server.docs.has('selection/2027/responses/' + ME));
  await waitFor(() => s.queue.pending() === 0);
  assert.deepEqual(await s.signIn({ method: 'token', code: 'tok-u2' }), { ok: true, reason: '' });
  await waitFor(() => users.at(-1)?.uid === 'u2');
  assert.equal(f.server.cleared, true, 'the last guest’s offline copy went first');
  assert.equal(outbox.size(), 0);
  assert.deepEqual(await s.send('2027', answer('B', 'guest-u2')), { state: 'sent' });
  assert.ok(f.server.docs.has('selection/2027/responses/guest-u2'));
});
