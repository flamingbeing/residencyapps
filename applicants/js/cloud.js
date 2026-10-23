// Sign-in and the Firestore handle (Firebase project residencyapps; who may do what is in firestore.rules).
// Everyone who answers, sets up or reads the results signs in with a passcode: the Worker (worker/guest.js) checks it and hands
// back a custom token (claim guest, role guest|setup|committee, no email). Admins sign in with Google; an admin is an email in
// admins/{email}, and a committee member one in selectionCommittee/{email} (both checked here, enforced by the rules).
// With ?demo nothing loads from Firebase: a made-up sign-in per role (?demo=guest|setup|committee|admin), and store.js keeps
// the data in this browser.

import { FIREBASE_CONFIG } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
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
function queued(p) {
  p.catch(e => console.error('Sync failed', e));
  return Promise.race([p, new Promise(r => setTimeout(r, ACK_WAIT))]);
}
export async function firestore() {
  const { db, F } = await sdk();
  return { db, F, queued };
}

// ---- sign-in ----

// a passcode account has no email: it is keyed as guest-<uid>; role from the token's claim (older tokens have none: guest)
async function asUser(u) {
  if (!u) return null;
  if (u.email) return { email: lc(u.email), name: u.displayName || u.email, uid: u.uid };
  let role = 'guest';
  try { const r = (await u.getIdTokenResult()).claims.role; if (r === 'setup' || r === 'committee') role = r; } catch {}
  return { email: 'guest-' + u.uid, name: 'Guest', uid: u.uid, guest: true, role };
}

export async function watchUser(cb) {
  if (demo) { demoCb = cb; cb(demoSignedOut ? null : demoUser(demoRole())); return; }
  if (!enabled) return;
  const { auth, A } = await sdk();
  A.getRedirectResult(auth).catch(e => console.warn('Redirect sign-in failed', e));
  A.onAuthStateChanged(auth, async u => cb(await asUser(u)));
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

// Signing out also wipes this device's offline copy (a shared ward PC keeps nothing).
export async function signOut() {
  if (demo) { demoSignedOut = true; demoCb?.(null); return; }
  const s = await sdk();
  await s.A.signOut(s.auth);
  try { await s.F.terminate(s.db); await s.F.clearIndexedDbPersistence(s.db); } catch (e) { console.warn('Could not clear the offline cache', e); }
  s.db = openDb(s.app, s.F);
}

// ---- roles of a Google sign-in ----

// { admin, committee }: a passcode account has neither (its role is on the user)
export async function getRoles(user) {
  if (!user || user.guest) return { admin: false, committee: false };
  if (demo) return { admin: true, committee: false };
  const { db, F } = await sdk();
  const has = async (col) => { try { return (await F.getDoc(F.doc(db, col, lc(user.email)))).exists(); } catch { return false; } };
  const [admin, committee] = await Promise.all([has('admins'), has('selectionCommittee')]);
  return { admin, committee };
}
