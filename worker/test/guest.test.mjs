// Guest passcode sign-in (worker/guest.js): the passcode check, the signed custom token, the limits. Run: node worker/test/guest.test.mjs
import assert from 'node:assert/strict';
import { handleGuest, customToken, sameSecret, storedCodes, clearCodesCache } from '../guest.js';
import worker from '../sites.js';

const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64').replace(/(.{64})/g, '$1\n') + '\n-----END PRIVATE KEY-----\n';
const env = { GUEST_PASSCODE: 'Open Sesame', GUEST_SA_EMAIL: 'guest@proj.iam.gserviceaccount.com', GUEST_SA_KEY: pem };
const req = (body, init = {}) => new Request('https://residencyapps.anawj.com/api/guest', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://residencyapps.anawj.com' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
let n = 0;
const t = async (name, fn) => { await fn(); n++; };

await t('the right passcode (any case) gets a token signed for Firebase', async () => {
  for (const p of ['Open Sesame', ' open sesame ']) {
    const r = await handleGuest(req({ passcode: p }), env);
    assert.equal(r.status, 200);
    const { token } = await r.json();
    const [h, b, s] = token.split('.');
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
    const c = JSON.parse(Buffer.from(b, 'base64url'));
    assert.equal(c.iss, env.GUEST_SA_EMAIL); assert.equal(c.sub, env.GUEST_SA_EMAIL);
    assert.equal(c.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
    assert.match(c.uid, /^g[0-9a-f]{24}$/); assert.deepEqual(c.claims, { guest: true, role: 'guest' });
    assert.ok(c.exp - c.iat <= 3600);
    assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + b)));
  }
});
await t('each guest gets a different id', async () => {
  const a = JSON.parse(Buffer.from((await (await handleGuest(req({ passcode: 'open sesame' }), env)).json()).token.split('.')[1], 'base64url')).uid;
  const b = JSON.parse(Buffer.from((await (await handleGuest(req({ passcode: 'open sesame' }), env)).json()).token.split('.')[1], 'base64url')).uid;
  assert.notEqual(a, b);
});
await t('a wrong, empty or missing passcode is refused', async () => {
  for (const body of [{ passcode: 'nope' }, { passcode: '' }, {}, { passcode: 5 }]) assert.equal((await handleGuest(req(body), env)).status, 401);
  assert.equal((await handleGuest(req('not json'), env)).status, 400);
});
await t('not set up answers 503, never a token', async () => {
  for (const k of Object.keys(env)) assert.equal((await handleGuest(req({ passcode: 'open sesame' }), { ...env, [k]: '' })).status, 503);
});
await t('only POST, only from the page itself', async () => {
  assert.equal((await handleGuest(new Request('https://residencyapps.anawj.com/api/guest'), env)).status, 405);
  assert.equal((await handleGuest(req({ passcode: 'open sesame' }, { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } }), env)).status, 403);
});
await t('the rate limit answers 429 without checking the passcode', async () => {
  const limited = { ...env, GUEST_LIMIT: { limit: async () => ({ success: false }) } };
  assert.equal((await handleGuest(req({ passcode: 'open sesame' }), limited)).status, 429);
});
await t('sameSecret compares by value', async () => {
  assert.equal(await sameSecret('abc', 'abc'), true); assert.equal(await sameSecret('abc', 'abd'), false); assert.equal(await sameSecret('abc', 'abcd'), false);
});
await t('only residencyapps.anawj.com/api/guest reaches it (no other host)', async () => {
  const ASSETS = { fetch: async () => new Response('x') };
  assert.equal((await worker.fetch(req({ passcode: 'open sesame' }), { ...env, ASSETS })).status, 200);
  const other = await worker.fetch(new Request('https://other.example.com/api/guest', { method: 'POST', body: '{}' }), { ...env, ASSETS });
  assert.equal(other.status, 405);
});

await t('the key may be stored with real or escaped new lines', async () => {
  for (const key of [pem, pem.replace(/\n/g, '\n'), pem.replace(/\n/g, '\r\n'), pem.trim()]) {
    const tok = await customToken({ ...env, GUEST_SA_KEY: key }, 'gx', 1000);
    const [h, b, s] = tok.split('.');
    assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + b)));
  }
});
await t('the set-up and committee passcodes give their own roles', async () => {
  const e2 = { ...env, SETUP_PASSCODE: 'Build It', COMMITTEE_PASSCODE: 'Read It' };
  const claims = async p => { const r = await handleGuest(req({ passcode: p }), e2); assert.equal(r.status, 200); const j = await r.json(); return { j, c: JSON.parse(Buffer.from(j.token.split('.')[1], 'base64url')) }; };
  assert.deepEqual((await claims('open sesame')).c.claims, { guest: true, role: 'guest' });
  const s = await claims(' build it '); assert.deepEqual(s.c.claims, { guest: true, role: 'setup' }); assert.equal(s.j.role, 'setup');
  const c = await claims('READ IT'); assert.deepEqual(c.c.claims, { guest: true, role: 'committee' }); assert.equal(c.j.role, 'committee');
  assert.equal((await handleGuest(req({ passcode: 'nope' }), e2)).status, 401);
});
await t('an unset optional passcode is never a way in', async () => {
  for (const p of ['', 'undefined', 'null']) assert.equal((await handleGuest(req({ passcode: p }), env)).status, 401);
  assert.equal((await handleGuest(req({ passcode: 'x' }), { ...env, SETUP_PASSCODE: '   ' })).status, 401);
});
// ---- passcodes changed on the Set up page (kept in Firestore, read with a service sign-in) ----
const realFetch = globalThis.fetch;
const storeEnv = { ...env, FIREBASE_API_KEY: 'key123', FIREBASE_PROJECT: 'proj-x', SETUP_PASSCODE: 'Build It' };
const doc = (role, code) => ({ name: `projects/proj-x/databases/(default)/documents/selectionCodes/${role}`, fields: { code: { stringValue: code } } });
function fakeStore(docs, { signInStatus = 200, readStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken')) return signInStatus === 200 ? new Response(JSON.stringify({ idToken: 'ID-TOKEN' })) : new Response('{}', { status: signInStatus });
    if (String(url).startsWith('https://firestore.googleapis.com/')) return readStatus === 200 ? new Response(JSON.stringify({ documents: docs })) : new Response('{}', { status: readStatus });
    throw new Error('unexpected fetch ' + url);
  };
  clearCodesCache();
  return calls;
}
const roleOf = async (p, e = storeEnv) => { const r = await handleGuest(req({ passcode: p }), e); return r.status === 200 ? (await r.json()).role : r.status; };
try {
  await t('a passcode set on the Set up page replaces the Worker secret of that role', async () => {
    const calls = fakeStore([doc('guest', 'New Guest Code')]);
    assert.equal(await roleOf('new guest code'), 'guest');
    assert.equal(await roleOf('open sesame'), 401, 'the old guest secret no longer works');
    assert.equal(await roleOf('build it'), 'setup', 'a role with no stored passcode keeps its secret');
    // the read is a service sign-in with the public key and the site as referrer, then a rules-checked read with the resulting ID token
    const [si, rd] = calls;
    assert.match(si.url, /signInWithCustomToken\?key=key123$/); assert.equal(si.init.headers.Referer, 'https://residencyapps.anawj.com/');
    const tok = JSON.parse(Buffer.from(JSON.parse(si.init.body).token.split('.')[1], 'base64url'));
    assert.deepEqual(tok.claims, { codesReader: true }); assert.equal(tok.uid, 'codes-reader');
    assert.equal(rd.url, 'https://firestore.googleapis.com/v1/projects/proj-x/databases/(default)/documents/selectionCodes?pageSize=10');
    assert.equal(rd.init.headers.Authorization, 'Bearer ID-TOKEN');
    assert.equal(calls.length, 2, 'three tries share one read (cached for a few seconds)');
  });
  await t('all three can come from the store, matched without case or spaces', async () => {
    fakeStore([doc('guest', 'Alpha-One'), doc('setup', 'Bravo-Two'), doc('committee', 'Charlie-Three')]);
    assert.equal(await roleOf(' ALPHA-one '), 'guest'); assert.equal(await roleOf('bravo-two'), 'setup'); assert.equal(await roleOf('charlie-three'), 'committee');
    assert.equal(await roleOf('build it'), 401, 'the setup secret is replaced too');
  });
  await t('a blank or unknown stored document is ignored', async () => {
    fakeStore([doc('guest', '   '), doc('admin', 'Hack Me'), { name: 'x/selectionCodes/setup', fields: {} }]);
    assert.equal(await roleOf('open sesame'), 'guest'); assert.equal(await roleOf('hack me'), 401); assert.equal(await roleOf('build it'), 'setup');
  });
  await t('if the store cannot be read, the Worker secrets still work', async () => {
    for (const opts of [{ signInStatus: 403 }, { readStatus: 500 }]) {
      fakeStore([doc('guest', 'New Guest Code')], opts);
      assert.equal(await roleOf('open sesame'), 'guest'); assert.equal(await roleOf('new guest code'), 401);
    }
    globalThis.fetch = async () => { throw new Error('offline'); }; clearCodesCache();
    assert.equal(await roleOf('open sesame'), 'guest');
  });
  await t('without the two public settings the store is never called', async () => {
    const calls = fakeStore([doc('guest', 'New Guest Code')]);
    assert.equal(await roleOf('open sesame', env), 'guest'); assert.equal(await roleOf('new guest code', env), 401);
    assert.equal(await storedCodes(env), null); assert.equal(calls.length, 0);
  });
  await t('the read is cached for a few seconds, then taken again', async () => {
    const calls = fakeStore([doc('guest', 'First Code')]);
    assert.equal((await storedCodes(storeEnv, 1000)).guest, 'First Code');
    assert.equal((await storedCodes(storeEnv, 1000 + 14000)).guest, 'First Code');
    assert.equal(calls.length, 2, 'one sign-in and one read serve both');
    globalThis.fetch = async (url) => String(url).includes('identitytoolkit') ? new Response(JSON.stringify({ idToken: 'T' })) : new Response(JSON.stringify({ documents: [doc('guest', 'Second Code')] }));
    assert.equal((await storedCodes(storeEnv, 1000 + 16000)).guest, 'Second Code');
  });
} finally { globalThis.fetch = realFetch; clearCodesCache(); }
console.log(`guest sign-in: ${n} groups passed`);
