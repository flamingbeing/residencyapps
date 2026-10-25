// The shared store (applicants/js/store.js) against a made-up Firestore: every read and write of the round, photos,
// responses, the committee list and the passcodes goes through cloud.js (the app's adapter, the only file that calls the
// Firebase SDK), with the same paths, data, error handling and waiting as before. cloud.useFirestore swaps in the fake.
// Run: node --test test/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cloud from '../applicants/js/cloud.js';
import * as store from '../applicants/js/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'applicants', 'js');

// ---- a made-up Firestore: documents in a Map keyed by path; every call is logged ----
function fakeFirestore() {
  const docs = new Map();
  const log = [];
  const server = { fromCache: false, deny: new Set(), hold: null, docs, log };   // deny: paths refused; hold: writes wait for it
  const fail = code => { const e = new Error(code); e.code = 'permission-denied'; return e; };
  const snapOf = (p, d) => ({ id: p.split('/').pop(), ref: { path: p }, exists: () => !!d, data: () => d && JSON.parse(JSON.stringify(d)) });
  const settle = async () => { if (server.hold) await server.hold; };
  const F = {
    collection: (_db, ...segs) => ({ path: segs.join('/') }),
    doc: (_db, ...segs) => ({ path: segs.join('/'), id: segs.at(-1) }),
    async getDocs(col) {
      log.push(['getDocs', col.path]);
      if (server.deny.has(col.path)) throw fail();
      const depth = col.path.split('/').length + 1;
      const out = [...docs].filter(([p]) => p.startsWith(col.path + '/') && p.split('/').length === depth).map(([p, d]) => snapOf(p, d));
      return { docs: out, metadata: { fromCache: server.fromCache } };
    },
    async getDoc(ref) {
      log.push(['getDoc', ref.path]);
      if (server.deny.has(ref.path)) throw fail();
      return snapOf(ref.path, docs.get(ref.path));
    },
    async setDoc(ref, data) { log.push(['setDoc', ref.path, data]); docs.set(ref.path, JSON.parse(JSON.stringify(data))); await settle(); },
    async deleteDoc(ref) { log.push(['deleteDoc', ref.path]); docs.delete(ref.path); await settle(); },
    writeBatch() {
      const dels = [];
      return { delete(ref) { dels.push(ref.path); }, async commit() { log.push(['batch', dels.length]); for (const p of dels) docs.delete(p); await settle(); } };
    },
  };
  return { F, db: {}, server };
}

// a stand-in for sync.js's saving: counts the writes sent straight to the SDK (track) and the server's answer (heard)
function fakeSaving() {
  const s = { tracked: 0, settled: 0, heardN: 0, sent: [] };
  s.track = p => { s.tracked++; Promise.resolve(p).catch(() => {}).finally(() => s.settled++); return p; };
  s.heard = () => { s.heardN++; };
  s.send = async (cycle, record) => { s.sent.push([cycle, record]); return { state: 'sent' }; };
  return s;
}

function setup() {
  const f = fakeFirestore(), saving = fakeSaving();
  cloud.useFirestore({ sdk: async () => ({ db: f.db, F: f.F }), saving });
  return { ...f, saving };
}
const writes = log => log.filter(x => x[0] !== 'getDocs' && x[0] !== 'getDoc');

test('only cloud.js (and firebase-config.js) call the Firebase SDK', () => {
  for (const f of fs.readdirSync(JS)) {
    if (f === 'cloud.js' || f === 'firebase-config.js') continue;
    const src = fs.readFileSync(path.join(JS, f), 'utf8');
    assert.doesNotMatch(src, /\bF\.\w+\(|cloud\.firestore\(|gstatic\.com\/firebasejs/, f);
  }
});

test('the round: listed newest first, the server answering marks heard, a cached answer does not', async () => {
  const { server, saving } = setup();
  server.docs.set('selection/2025', { title: 'Old', status: 'closed', applicants: [{ id: 'a1', name: 'A' }], updatedAt: 1 });
  server.docs.set('selection/2026', { title: 'New', status: 'open', applicants: [{ id: 'a1', name: 'A' }], opensAt: 5, updatedAt: 2 });
  server.docs.set('selection/2026/photos/a1', { jpeg: 'x' });   // a subcollection is not a round
  const list = await store.listRounds();
  assert.deepEqual(list.map(r => [r.cycle, r.status, r.shared, r.opensAt]), [['2026', 'open', true, 5], ['2025', 'closed', true, null]]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(saving.heardN, 1);
  server.fromCache = true;
  assert.equal((await store.openRound()).cycle, '2026');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(saving.heardN, 1);
});

test('saveRound: the whole round set at selection/{cycle}, tracked, back as a round', async () => {
  const { server, saving } = setup();
  const r = await store.saveRound({ cycle: '20 26!', title: 'T', applicants: [{ id: 'a1', name: 'A', entry: 3, x: 1 }], questions: [{ id: 'q' }], form: { id: 'f', nameEntry: 1 }, mirror: 1, opensAt: '10', closesAt: '' }, 'closed');
  const [[op, p, doc]] = writes(server.log);
  assert.equal(op, 'setDoc'); assert.equal(p, 'selection/2026');
  assert.deepEqual(Object.keys(doc).sort(), ['applicants', 'cycle', 'form', 'mirror', 'opensAt', 'questions', 'status', 'title', 'updatedAt']);
  assert.deepEqual(doc.applicants, [{ id: 'a1', name: 'A', entry: 3 }]);
  assert.equal(doc.status, 'closed'); assert.equal(doc.mirror, true); assert.equal(doc.opensAt, 10);
  assert.equal(r.cycle, '2026'); assert.equal(r.status, 'closed');
  assert.equal(saving.tracked, 1);
});

test('a round, committee or passcode save goes on after a while when the server is slow (queued); photo writes wait', async () => {
  const { server, saving } = setup();
  let release; server.hold = new Promise(r => { release = r; });
  const t0 = Date.now();
  await store.saveCode('guest', ' secret1 ');
  const waited = Date.now() - t0;
  assert.ok(waited >= 2900 && waited < 4500, 'waited ' + waited);
  assert.deepEqual(server.docs.get('selectionCodes/guest').code, 'secret1');
  let photoDone = false;
  const ph = store.savePhoto('2026', 'a1', 'jpegdata').then(() => { photoDone = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(photoDone, false);
  assert.equal(saving.settled, 0);
  release(); await ph;
  assert.equal(photoDone, true);
  assert.equal(saving.tracked, 2);
});

test('a refused queued write still throws (the server said no inside the wait)', async () => {
  const { F } = setup();
  F.setDoc = async () => { const e = new Error('no'); e.code = 'permission-denied'; throw e; };
  const err = console.error; console.error = () => {};
  try { await assert.rejects(store.saveCommittee({ email: 'A@B.co', name: 'N' }), { code: 'permission-denied' }); }
  finally { console.error = err; }
});

test('photos: listed as image sources, saved, removed; a refused list is empty, other errors throw', async () => {
  const { server, saving } = setup();
  await store.savePhoto('2026', 'a1', '/9j/abc');
  assert.deepEqual(server.docs.get('selection/2026/photos/a1').jpeg, '/9j/abc');
  assert.equal(typeof server.docs.get('selection/2026/photos/a1').updatedAt, 'number');
  server.docs.set('selection/2026/photos/a2', { jpeg: '' });
  assert.deepEqual(Object.keys(await store.listPhotos('2026')), ['a1']);
  await store.removePhoto('2026', 'a1');
  assert.equal(server.docs.has('selection/2026/photos/a1'), false);
  assert.equal(saving.tracked, 2);
  server.deny.add('selection/2026/photos');
  assert.deepEqual(await store.listPhotos('2026'), {});
  const { F } = setup();
  F.getDocs = async () => { const e = new Error('x'); e.code = 'unavailable'; throw e; };
  await assert.rejects(store.listPhotos('2026'), { code: 'unavailable' });
});

test('responses: my own (no id or serverAt; refused is none), every one (stamp as ms), send through the outbox', async () => {
  const { server, saving } = setup();
  assert.equal(await store.myResponse('2026', 'Guest-u1'), null);
  server.docs.set('selection/2026/responses/guest-u1', { id: 'guest-u1', email: 'guest-u1', name: 'G', answers: { a1: { score: 5 } }, updatedAt: 7, serverAt: { s: 1 } });
  assert.deepEqual(await store.myResponse('2026', 'GUEST-U1'), { email: 'guest-u1', name: 'G', answers: { a1: { score: 5 } }, updatedAt: 7 });
  server.docs.set('selection/2026/responses/old@x.co', { email: 'old@x.co', name: 'O', answers: {} });
  const all = await store.listResponses('2026');
  assert.deepEqual(all.map(r => [r.email, r.updatedAt, 'id' in r, 'serverAt' in r]), [['guest-u1', 7, false, false], ['old@x.co', 0, false, false]]);
  server.deny.add('selection/2026/responses/guest-u1');
  assert.equal(await store.myResponse('2026', 'guest-u1'), null);
  server.deny.add('selection/2026/responses');
  await assert.rejects(store.listResponses('2026'), { code: 'permission-denied' });
  const round = { cycle: '2026', applicants: [{ id: 'a1', name: 'A' }], questions: [{ id: 'score', type: 'scale' }] };
  assert.equal(await store.sendResponse(round, { email: 'Guest-U1' }, 'G', {}), 'sent');
  assert.equal(saving.sent[0][0], '2026'); assert.equal(saving.sent[0][1].id, 'guest-u1');
  assert.equal(writes(server.log).length, 0);   // answers never go straight to the SDK
});

test('listResponses gives a Timestamp stamp as ms', async () => {
  const { F } = setup();
  F.getDocs = async () => ({ docs: [{ id: 'x', data: () => ({ email: 'x', updatedAt: { toMillis: () => 42 } }) }], metadata: {} });
  assert.equal((await store.listResponses('c'))[0].updatedAt, 42);
});

test('the retention delete: every response and photo in batches of 400, each tracked, counts back; the round stays', async () => {
  const { server, saving } = setup();
  server.docs.set('selection/2026', { title: 'T', status: 'closed', applicants: [{ id: 'a1', name: 'A' }] });
  for (let i = 0; i < 801; i++) server.docs.set('selection/2026/responses/r' + i, { email: 'r' + i });
  for (let i = 0; i < 3; i++) server.docs.set('selection/2026/photos/a' + i, { jpeg: 'x' });
  server.docs.set('selection/2025/responses/keep', { email: 'keep' });
  assert.deepEqual(await store.deleteRoundData('2026'), { responses: 801, photos: 3 });
  assert.deepEqual(writes(server.log), [['batch', 400], ['batch', 400], ['batch', 1], ['batch', 3]]);
  assert.equal(saving.tracked, 4);
  assert.ok(server.docs.has('selection/2026'));
  assert.ok(server.docs.has('selection/2025/responses/keep'));
  assert.deepEqual(await store.deleteRoundData('2024'), { responses: 0, photos: 0 });
});

test('the committee: listed by email, saved lower-case with the name only, removed; a bad email is refused', async () => {
  const { server, saving } = setup();
  await store.saveCommittee({ email: ' B@X.co ', name: '  Dr B  ' });
  await store.saveCommittee({ email: 'a@x.co' });
  assert.deepEqual(server.docs.get('selectionCommittee/b@x.co'), { name: 'Dr B' });
  assert.deepEqual(await store.listCommittee(), [{ email: 'a@x.co', name: '' }, { email: 'b@x.co', name: 'Dr B' }]);
  await store.removeCommittee('A@X.CO');
  assert.equal(server.docs.has('selectionCommittee/a@x.co'), false);
  await assert.rejects(store.saveCommittee({ email: 'nope' }), /email/);
  assert.equal(saving.tracked, 3);
});

test('the passcodes: listed (strings only), saved with updatedAt; an unknown role is refused', async () => {
  const { server } = setup();
  await store.saveCode('setup', 'abcdef');
  server.docs.set('selectionCodes/committee', { code: 5 });
  const codes = await store.listCodes();
  assert.deepEqual(codes, { setup: 'abcdef' });
  assert.deepEqual(Object.keys(server.docs.get('selectionCodes/setup')).sort(), ['code', 'updatedAt']);
  await assert.rejects(store.saveCode('admin', 'abcdef'), /Unknown/);
});

test('roles of a Google sign-in: admins/{email} and selectionCommittee/{email}; a refused read is no', async () => {
  const { server } = setup();
  server.docs.set('admins/a@x.co', {});
  assert.deepEqual(await cloud.getRoles({ email: 'A@x.co' }), { admin: true, committee: false });
  server.deny.add('selectionCommittee/a@x.co');
  assert.deepEqual(await cloud.getRoles({ email: 'a@x.co' }), { admin: true, committee: false });
  assert.deepEqual(await cloud.getRoles({ guest: true }), { admin: false, committee: false });
});
