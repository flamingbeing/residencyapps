// Sign-in and the Firestore handle (Firebase project residencyapps; who may do what is in firestore.rules).
// Everyone who answers, sets up or reads the results signs in with a passcode: the Worker (worker/guest.js) checks it and hands
// back a custom token (role guest|setup|committee as claim role, or app-devkit's m passcode, g { _: role }; no email). Admins sign in with Google; an admin is an email in
// admins/{email}, and a committee member one in selectionCommittee/{email} (both checked here, enforced by the rules).
// With ?demo nothing loads from Firebase: a made-up sign-in per role (?demo=guest|setup|committee|admin), and store.js keeps
// the data in this browser.

import { FIREBASE_CONFIG } from './firebase-config.js';
import { createSaving } from './sync.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SYNC = 'https://core.anawj.com/sync/0.6.3/index.js';   // app-sync, one exact version (also in sw.js SHELL)
const params = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } })();
export const demo = params.has('demo');
export const enabled = demo || !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
const lc = s => String(s || '').trim().toLowerCase();
const ACK_WAIT = 3000;   // ms to wait for the server before treating a write as queued

// ---- the demo sign-in ----

export const DEMO_ROLES = { guest: 'Guest (sends feedback)', setup: 'Set-up passcode', committee: 'Committee passcode', admin: 'Admin (Google sign-in)' };
const DEMO_KEY = 'sel-demo-role';
const demoUser = role => (role === 'admin'
  ? { email: 'admin@example.com', name: 'Demo Admin', uid: 'demo-admin' }
  : { email: 'guest-demo-' + role, name: role === 'guest' ? 'Guest' : DEMO_ROLES[role], uid: 'demo-' + role, guest: true, role });
export function demoRole() {
  const q = params.get('demo');
  if (q in DEMO_ROLES) { try { localStorage.setItem(DEMO_KEY, q); } catch {} return q; }
  try { const r = localStorage.getItem(DEMO_KEY); if (r in DEMO_ROLES) return r; } catch {}
  return 'guest';
}
export function setDemoRole(role) {
  try { localStorage.setItem(DEMO_KEY, role); } catch {}
  const q = new URLSearchParams(location.search); q.set('demo', role);
  history.replaceState(null, '', location.pathname + '?' + q + location.hash);
}
let demoSignedOut = false;
let demoCb = null;

// ---- Firebase ----

let fb = null;
async function sdk() {
  if (fb) return fb;
  fb = (async () => {
    const [app, auth, fs] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
    const a = app.initializeApp(FIREBASE_CONFIG);
    return { app: a, auth: auth.getAuth(a), db: openDb(a, fs), A: auth, F: fs };
  })();
  fb.catch(() => { fb = null; });   // e.g. offline on first ever load: try again next time
  return fb;
}
function openDb(a, fs) {
  try { return fs.initializeFirestore(a, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
  catch (e) { console.warn('Offline cache unavailable; using memory only', e); return fs.getFirestore(a); }
}
// A write applies to the local cache at once but only settles when the server confirms: wait a little, then go on.
// Either way it is counted as unsent until the server has it (sync.js track: the status and the sign-out check).
function queued(p) {
  p.catch(e => console.error('Sync failed', e));
  void track(p);
  return Promise.race([p, new Promise(r => setTimeout(r, ACK_WAIT))]);
}
// The shared store's reads and writes (store.js), so no other file calls the SDK. A path is its segments
// (['selection', cycle, 'photos']). Errors are the SDK's own (e.g. code 'permission-denied'), passed on unchanged.
//   list(path) -> { fromCache, docs: [{ id, data }] }; get(path) -> the data, or null when there is none
//   set(path, data) / remove(path): queued (back after the server's answer or ACK_WAIT, whichever is first)
//   setNow(path, data) / removeNow(path): tracked, back once the server has it
//   removeAll(path) -> how many: every document of a collection, in batches (at most 500 writes; 400 each), tracked
let testHook = null;
const data = () => testHook ? testHook.sdk() : sdk();
export const docs = {
  async list(path) {
    const { db, F } = await data();
    const snap = await F.getDocs(F.collection(db, ...path));
    return { fromCache: !!snap.metadata?.fromCache, docs: snap.docs.map(d => ({ id: d.id, data: d.data() })) };
  },
  async get(path) {
    const { db, F } = await data();
    const s = await F.getDoc(F.doc(db, ...path));
    return s.exists() ? s.data() : null;
  },
  async set(path, doc) { const { db, F } = await data(); await queued(F.setDoc(F.doc(db, ...path), doc)); },
  async remove(path) { const { db, F } = await data(); await queued(F.deleteDoc(F.doc(db, ...path))); },
  async setNow(path, doc) { const { db, F } = await data(); await track(F.setDoc(F.doc(db, ...path), doc)); },
  async removeNow(path) { const { db, F } = await data(); await track(F.deleteDoc(F.doc(db, ...path))); },
  async removeAll(path) {
    const { db, F } = await data();
    const all = (await F.getDocs(F.collection(db, ...path))).docs;
    for (let i = 0; i < all.length; i += 400) {
      const b = F.writeBatch(db);
      all.slice(i, i + 400).forEach(x => b.delete(x.ref));
      await track(b.commit());
    }
    return all.length;
  },
};
// tests only (test/store.test.mjs): { sdk: async () => ({ db, F }), saving } in place of Firebase and sync.js; null undoes it
export function useFirestore(hook) { testHook = hook; }

// ---- answers through app-sync's outbox (sync.js); not in the demo ----

let saving = null;
export function sending() {
  if (testHook) return Promise.resolve(testHook.saving);
  if (demo || !enabled) return Promise.resolve(null);
  saving ||= (async () => createSaving({ AS: await import(SYNC), sdk: async () => { const s = await sdk(); return { A: s.A, F: s.F, auth: s.auth, get db() { return s.db; } }; } }))();
  saving.catch(() => { saving = null; });   // e.g. offline on first ever load: try again next time
  return saving;
}
// a write sent straight to the SDK, counted until it settles (none in the demo)
function track(p) { sending().then(s => { s?.track(p); }, () => {}); return p; }   // the caller handles p's error

// ---- sign-in ----

// a passcode account has no email: it is keyed as guest-<uid>; role from the token's claim (older tokens have none: guest)
async function asUser(u) {
  if (!u) return null;
  if (u.email) return { email: lc(u.email), name: u.displayName || u.email, uid: u.uid };
  let role = 'guest';
  // the role claim (older tokens) or app-devkit's g { _: role } (worker/custom-token.js)
  try { const c = (await u.getIdTokenResult()).claims, r = c.m === 'passcode' ? c.g?._ : c.role; if (r === 'setup' || r === 'committee') role = r; } catch {}
  return { email: 'guest-' + u.uid, name: 'Guest', uid: u.uid, guest: true, role };
}

export async function watchUser(cb) {
  if (demo) { demoCb = cb; cb(demoSignedOut ? null : demoUser(demoRole())); return; }
  if (!enabled) return;
  const { auth, A } = await sdk();
  A.getRedirectResult(auth).catch(e => console.warn('Redirect sign-in failed', e));
  A.onAuthStateChanged(auth, async u => {
    const user = await asUser(u);
    // this person's answers not sent before a reload start going again
    if (user) await sending().then(sv => sv?.activate(user.email)).catch(e => console.warn('Outbox unavailable', e));
    cb(user);
  });
}

// Admins: Google, popup first; redirect when popups are blocked or unsupported (some home-screen apps).
const REDIRECT_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported', 'auth/cancelled-popup-request'];
export async function signInAdmin() {
  if (demo) { demoSignedOut = false; setDemoRole('admin'); demoCb?.(demoUser('admin')); return; }
  const { auth, A } = await sdk();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try { await A.signInWithPopup(auth, provider); }
  catch (e) { if (!REDIRECT_CODES.includes(e?.code)) throw e; await A.signInWithRedirect(auth, provider); }
}

// Everyone else: the passcode. The Worker answers { token, role } or an error.
export async function signInWithPasscode(passcode) {
  if (demo) { demoSignedOut = false; demoCb?.(demoUser(demoRole() === 'admin' ? 'guest' : demoRole())); return; }
  const res = await fetch('/api/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) });
  const b = await res.json().catch(() => ({}));
  if (!res.ok || !b.token) throw new Error(res.status === 401 ? 'That passcode isn’t right.' : res.status === 429 ? 'Too many tries. Wait a minute.' : b.error || 'Couldn’t sign in.');
  const { auth, A } = await sdk();
  await A.signInWithCustomToken(auth, b.token);
}

// Signing out also wipes this device's offline copy (a shared ward PC keeps nothing): the outbox and the SDK's cache
// (app-sync forgetDevice). Refused while answers or other changes are not on the server yet, unless force.
// -> { ok: true } or { ok: false, unsent: true }
export async function signOut({ force = false } = {}) {
  if (demo) { demoSignedOut = true; demoCb?.(null); return { ok: true }; }
  const s = await sdk();
  const sv = await sending().catch(() => null);
  if (!sv) {
    await s.A.signOut(s.auth);
    try { await s.F.terminate(s.db); await s.F.clearIndexedDbPersistence(s.db); } catch (e) { console.warn('Could not clear the offline cache', e); }
    s.db = openDb(s.app, s.F);
    return { ok: true };
  }
  const r = await sv.signOut({ force, before: () => s.A.signOut(s.auth) });
  if (r.ok) s.db = openDb(s.app, s.F);
  return r;
}

// ---- roles of a Google sign-in ----

// { admin, committee }: a passcode account has neither (its role is on the user)
export async function getRoles(user) {
  if (!user || user.guest) return { admin: false, committee: false };
  if (demo) return { admin: true, committee: false };
  const has = async (col) => { try { return (await docs.get([col, lc(user.email)])) !== null; } catch { return false; } };
  const [admin, committee] = await Promise.all([has('admins'), has('selectionCommittee')]);
  return { admin, committee };
}
