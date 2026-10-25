// Passcode sign-in for the applicants app (NOTES.md): POST residencyapps.anawj.com/api/guest {passcode} answers {token}, a
// Firebase custom token that signs the person in without an account (app-devkit's claims shape: m passcode, g { _: role }; no
// email; the token is made by worker/custom-token.js, a copy of app-devkit's, kept unchanged). The rules
// (firestore.rules: isGuest, isSetupCode, isCommitteeCode) decide what each role may do; nothing else in the project opens to them.
// Secrets, set in Cloudflare (never in this repo): GUEST_PASSCODE, GUEST_SA_EMAIL and GUEST_SA_KEY (the PEM private key of a
// service account in the Firebase project that has no roles: it only signs the tokens). Optional binding GUEST_LIMIT (a Workers
// rate limit) caps tries per address. Without the secrets it answers 503. It stores nothing.
// The passcodes can also be changed on the app's Set up page: they are then kept in Firestore (selectionCodes/{role}, rules:
// firestore.rules), and the Worker reads them with a service sign-in (a custom token with claim codesReader, no email,
// exchanged for an ID token with the public web API key) when the vars FIREBASE_API_KEY and FIREBASE_PROJECT are set
// (wrangler.jsonc). A role with no stored passcode uses its Worker secret, so the secrets stay as the fallback.

import { customToken as kitToken, randomUid } from './custom-token.js';

export const GUEST_HOST = 'residencyapps.anawj.com';
export const GUEST_PATH = '/api/guest';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });

// compares two strings without leaking where they differ (both hashed first, so the length doesn't leak either)
export async function sameSecret(a, b) {
  const h = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(String(a)), h(String(b))]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// role: guest|setup|committee (a passcode account), or codesReader (the Worker's own sign-in that reads the passcodes)
export const customToken = (env, uid, now = Math.floor(Date.now() / 1000), role = 'guest') =>
  kitToken({ email: env.GUEST_SA_EMAIL, key: env.GUEST_SA_KEY }, uid, role === 'codesReader' ? { g: { _: role }, v: 1 } : { m: 'passcode', g: { _: role }, v: 1 }, now);

// The passcodes kept in Firestore (set on the app's Set up page): { guest?, setup?, committee? }, or null when the Worker isn't
// set up to read them. Cached for a few seconds, so a change takes effect almost at once and a burst of tries costs one read.
const CODES_TTL = 15000;
let codesCache = null;
export const clearCodesCache = () => { codesCache = null; };
export async function storedCodes(env, now = Date.now()) {
  if (!env.FIREBASE_API_KEY || !env.FIREBASE_PROJECT) return null;
  if (codesCache && now - codesCache.at < CODES_TTL) return codesCache.codes;
  const token = await customToken(env, 'codes-reader', undefined, 'codesReader');
  // the web API key is restricted to this site's address, so the call says where it comes from
  const si = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: `https://${GUEST_HOST}/` }, body: JSON.stringify({ token, returnSecureToken: true }) });
  const idToken = si.ok ? (await si.json()).idToken : null;
  if (!idToken) throw new Error('service sign-in ' + si.status);
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT)}/databases/(default)/documents/selectionCodes?pageSize=10`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok) throw new Error('read ' + r.status);
  const codes = {};
  for (const d of (await r.json()).documents || []) {
    const role = String(d.name || '').split('/').pop(), code = d.fields?.code?.stringValue;
    if (['guest', 'setup', 'committee'].includes(role) && typeof code === 'string' && code.trim()) codes[role] = code;
  }
  codesCache = { at: now, codes };
  return codes;
}

export async function handleGuest(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);
  const missing = ['GUEST_PASSCODE', 'GUEST_SA_EMAIL', 'GUEST_SA_KEY'].filter(k => !env[k]);
  if (missing.length) return json({ error: 'Guest sign-in is not set up yet.' }, 503);
  const origin = request.headers.get('Origin');
  if (origin && origin !== `https://${GUEST_HOST}`) return json({ error: 'Wrong origin.' }, 403);
  if (env.GUEST_LIMIT) {
    const { success } = await env.GUEST_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json({ error: 'Too many tries.' }, 429);
  }
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Not JSON.' }, 400); }
  const given = (typeof b?.passcode === 'string' ? b.passcode.trim().slice(0, 100) : '').toLowerCase();
  // three passcodes, three roles: guests send feedback; SETUP_PASSCODE opens Set up; COMMITTEE_PASSCODE reads the results. The last two are optional secrets.
  // A passcode changed on the Set up page (Firestore) replaces the Worker secret of the same role. If it can't be read, the secrets
  // still work, so a Firestore or key problem never locks everyone out.
  let stored = null;
  try { stored = await storedCodes(env); } catch (e) { console.error('passcode store unreadable, using the secrets', e?.message); }
  let role = null;
  if (given) for (const [r, secret] of [['guest', stored?.guest ?? env.GUEST_PASSCODE], ['setup', stored?.setup ?? env.SETUP_PASSCODE], ['committee', stored?.committee ?? env.COMMITTEE_PASSCODE]]) {
    if (secret && String(secret).trim() && await sameSecret(given, String(secret).trim().toLowerCase()) && !role) role = r;
  }
  if (!role) return json({ error: 'Wrong passcode.' }, 401);
  const uid = randomUid('g');
  try { return json({ token: await customToken(env, uid, undefined, role), role }); }
  catch (e) { console.error('guest token failed', e?.name, e?.message); return json({ error: 'Couldn’t sign in (' + (e?.name || 'error') + ': ' + String(e?.message || '').slice(0, 120) + ').' }, 500); }
}
