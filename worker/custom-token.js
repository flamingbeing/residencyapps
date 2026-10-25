// app-devkit worker/custom-token.js 1.4.0. Firebase custom tokens signed in a Cloudflare Worker (Web Crypto, no
// dependencies), carrying the rules kit's claims shape as developer claims. For people who sign in by link, passcode or
// anonymously: the Worker checks the link or code (the app's own code), then returns customToken(...) and the page calls
// signInWithCustomToken. Developer claims stay on that sign-in across ID token refreshes (tested in the emulator); new
// claims need a new token and a new sign-in.
//
// The service account signs only. Keep its email and PEM private key in Worker secrets, never in a repo.

export const TOKEN_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
export const METHODS = ['google', 'link', 'passcode', 'email', 'password', 'anon'];
const MAX_GROUPS = 20;
const MAX_BYTES = 1000; // Firebase's limit for the claims payload

const enc = new TextEncoder();
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const json64 = (o) => b64url(enc.encode(JSON.stringify(o)));

// Checks and copies a claims object in the kit's shape: { m?, g?, x?, v? } and nothing else. Throws on anything off.
export function claimsShape({ m, g, x, v, ...rest } = {}) {
  const extra = Object.keys(rest);
  if (extra.length) throw new Error(`claims: unknown key ${extra[0]} (only m, g, x, v)`);
  const out = {};
  if (m !== undefined) {
    if (!METHODS.includes(m)) throw new Error(`claims: m must be one of ${METHODS.join(', ')}`);
    out.m = m;
  }
  if (g !== undefined) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('claims: g must be an object { groupId: role }');
    const entries = Object.entries(g);
    if (entries.length > MAX_GROUPS) throw new Error(`claims: g has ${entries.length} groups (at most ${MAX_GROUPS})`);
    out.g = {};
    for (const [gid, role] of entries) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(gid)) throw new Error(`claims: bad group id ${JSON.stringify(gid).slice(0, 80)}`);
      if (typeof role !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(role)) throw new Error(`claims: bad role for ${gid}`);
      out.g[gid] = role;
    }
  }
  if (x !== undefined) {
    if (!Number.isInteger(x) || x <= 0 || x > 1e11) throw new Error('claims: x must be unix seconds (an integer)');
    out.x = x;
  }
  if (v !== undefined) {
    if (!Number.isInteger(v) || v < 0) throw new Error('claims: v must be a whole number');
    out.v = v;
  }
  const bytes = enc.encode(JSON.stringify(out)).length;
  if (bytes > MAX_BYTES) throw new Error(`claims: ${bytes} bytes (at most ${MAX_BYTES})`);
  return out;
}

// The PEM private key of a service account, however the secret was pasted (real or escaped new lines).
export async function serviceKey(pem) {
  if (!pem) throw new Error('service account key missing');
  const m = String(pem).match(/-----BEGIN[^-]*-----([\s\S]*?)-----END/);
  const body = (m ? m[1] : String(pem)).replace(/\\+[nrt]/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// An RS256 JWT signed with the service account's key. key: a CryptoKey from serviceKey, or the PEM text.
export async function signJwt(key, payload) {
  const k = typeof key === 'string' ? await serviceKey(key) : key;
  const unsigned = `${json64({ alg: 'RS256', typ: 'JWT' })}.${json64(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, enc.encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

// A random uid for people with no account (link or passcode sign-in): prefix + 24 hex characters.
export const randomUid = (prefix = 'u') => prefix + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

// sa: { email, key } (key = PEM text or CryptoKey). uid: 1-128 characters. claims: the kit's shape (checked).
// The token is valid for one hour, to be exchanged at once; the sign-in it starts lasts until sign-out.
export async function customToken(sa, uid, claims = {}, now = Math.floor(Date.now() / 1000)) {
  if (!sa?.email || !sa?.key) throw new Error('service account email and key are needed');
  if (typeof uid !== 'string' || uid.length < 1 || uid.length > 128) throw new Error('uid must be 1-128 characters');
  const shaped = claimsShape(claims);
  const body = { iss: sa.email, sub: sa.email, aud: TOKEN_AUD, iat: now, exp: now + 3600, uid };
  if (Object.keys(shaped).length) body.claims = shaped;
  return signJwt(sa.key, body);
}
