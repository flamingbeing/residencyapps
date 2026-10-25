// The app's shared store: the round, its photos, each respondent's response, the committee list and the passcodes.
// Live: Firestore in the project residencyapps (rules: firestore.rules):
//   selection/{cycle}                       { cycle, title, status: 'open'|'closed', applicants: [{ id, name }], questions?, opensAt?, closesAt?, updatedAt }
//   selection/{cycle}/photos/{applicantId}  { jpeg: base64 JPEG (passport shaped, a few KB), updatedAt }
//   selection/{cycle}/responses/{id}        { email: id, name, answers: { [applicantId]: { na, [questionId]: value } }, updatedAt }
//                                           id: guest-<uid> (a passcode sign-in); answers copied from the app's first home keep their email id
//   selectionCommittee/{email}              { name }  Google sign-ins that read the results (kept by admins)
//   selectionCodes/{role}                   { code, updatedAt }  role: guest, setup or committee; read by admins and the Worker (worker/guest.js)
// With ?demo: the same calls against this browser's localStorage, seeded with made-up applicants, photos and answers, so
// every screen can be tried (the demo role switch is in the account sheet).

import * as cloud from './cloud.js';
import { cleanRound, cleanAnswers, photoSrc, demoRound, demoPhoto } from './model.js';

const lc = s => String(s || '').trim().toLowerCase();
const DEMO_KEY = 'sel-demo-store';
const demoRead = () => { try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || {}; } catch { return {}; } };
const demoWrite = d => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); } catch {} };
function demoDb() {
  const d = demoRead();
  d.rounds ||= {}; d.responses ||= {}; d.committee ||= {}; d.photos ||= {}; d.codes ||= {};
  if (!d.seeded) { seedDemo(d); demoWrite(d); }
  return d;
}
// The demo starts as a published round with photos, a committee member and four people's answers (all made up), so
// Results and the photo grid have something in them; ?demo=reset puts it back (app.js).
function seedDemo(d) {
  const r = demoRound();
  d.rounds[r.cycle] = { cycle: r.cycle, title: r.title, status: 'open', applicants: r.applicants, questions: r.questions, updatedAt: Date.now() };
  r.applicants.forEach((a, i) => { d.photos[r.cycle + '|' + a.id] = demoPhoto(i); });
  d.committee['committee@example.com'] = { name: 'Dr Demo Committee' };
  const sample = [
    ['sample.one@example.com', 'Dr Sample One', { a1: [5, 'Calm in a crisis; asked for help early.'], a2: [4, 'Reliable on call.'], a3: 'na', a4: [3, ''], a5: [2, 'Struggled with feedback.'], a8: [4, ''] }],
    ['sample.two@example.com', 'Dr Sample Two', { a1: [4, 'Good teamwork in the ICU.'], a2: [5, 'Went beyond what was asked.'], a3: [3, ''], a6: 'na', a7: [4, 'Thoughtful, quiet, well prepared.'] }],
    ['sample.three@example.com', 'Dr Sample Three', { a1: [5, ''], a4: [4, 'Kind with patients and nurses.'], a5: [3, ''], a7: 'na', a8: [5, 'Excellent handover.'] }],
    ['sample.four@example.com', 'Dr Sample Four', { a2: [4, ''], a3: [2, 'Late twice that I saw.'], a6: [5, 'Outstanding initiative.'], a7: [4, ''], a8: [3, ''] }],
  ];
  const t = Date.now() - 36e5;
  for (const [email, name, per] of sample) {
    const answers = {};
    for (const a of r.applicants) {
      const v = per[a.id];
      if (!v) continue;
      answers[a.id] = v === 'na' ? { na: true } : { score: v[0], ...(v[1] ? { comment: v[1] } : {}) };
    }
    d.responses[r.cycle + '|' + email] = { email, name, answers, updatedAt: t };
  }
  d.seeded = true;
}
export function resetDemo() { try { localStorage.removeItem(DEMO_KEY); for (const k of Object.keys(localStorage)) if (k.startsWith('sel-demo-')) localStorage.removeItem(k); } catch {} }

const when = v => (Number.isFinite(Number(v)) && v != null && v !== '' ? Number(v) : null);
const toRound = (id, d) => {
  const r = cleanRound({ cycle: id, title: d.title, applicants: d.applicants, questions: d.questions, form: d.form, mirror: d.mirror });
  return r ? { ...r, cycle: id, shared: true, status: d.status === 'closed' ? 'closed' : 'open', opensAt: when(d.opensAt), closesAt: when(d.closesAt), updatedAt: Number(d.updatedAt) || 0 } : null;
};
const byNewest = (a, b) => b.updatedAt - a.updatedAt;

// every round (staff and the committee pick one to look at)
export async function listRounds() {
  if (cloud.demo) return Object.entries(demoDb().rounds).map(([id, d]) => toRound(id, d)).filter(Boolean).sort(byNewest);
  const snap = await cloud.docs.list(['selection']);
  if (!snap.fromCache) cloud.sending().then(s => s?.heard(), () => {});   // the server answered: the status may say synced
  return snap.docs.map(d => toRound(d.id, d.data)).filter(Boolean).sort(byNewest);
}
export const openRound = async () => (await listRounds()).find(r => r.status === 'open') || null;

export async function saveRound(round, status = 'open') {
  const cycle = String(round.cycle || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || String(new Date().getFullYear());
  const doc = { cycle, title: round.title, status, applicants: round.applicants.map(a => (a.entry ? { id: a.id, name: a.name, entry: a.entry } : { id: a.id, name: a.name })), questions: round.questions, updatedAt: Date.now() };
  if (round.form) { doc.form = round.form; doc.mirror = !!round.mirror; }
  // open and close dates (ms): the rules refuse answers outside them, so no scheduled job is needed
  for (const k of ['opensAt', 'closesAt']) if (when(round[k]) != null) doc[k] = when(round[k]);
  if (cloud.demo) { const d = demoDb(); d.rounds[cycle] = doc; demoWrite(d); return toRound(cycle, doc); }
  await cloud.docs.set(['selection', cycle], doc);
  return toRound(cycle, doc);
}

// ---- photos: { applicantId: image src } for a round ----

export async function listPhotos(cycle) {
  if (cloud.demo) {
    const out = {}; const p = demoDb().photos;
    for (const k of Object.keys(p)) if (k.startsWith(cycle + '|')) out[k.slice(cycle.length + 1)] = p[k];
    return out;
  }
  const out = {};
  try { for (const d of (await cloud.docs.list(['selection', cycle, 'photos'])).docs) { const src = photoSrc(d.data.jpeg); if (src) out[d.id] = src; } }
  catch (e) { if (e?.code !== 'permission-denied') throw e; }
  return out;
}
// jpeg: base64 JPEG (photo.js makes it)
export async function savePhoto(cycle, applicantId, jpeg) {
  if (cloud.demo) { const d = demoDb(); d.photos[cycle + '|' + applicantId] = photoSrc(jpeg); demoWrite(d); return; }
  await cloud.docs.setNow(['selection', cycle, 'photos', applicantId], { jpeg, updatedAt: Date.now() });
}
export async function removePhoto(cycle, applicantId) {
  if (cloud.demo) { const d = demoDb(); delete d.photos[cycle + '|' + applicantId]; demoWrite(d); return; }
  await cloud.docs.removeNow(['selection', cycle, 'photos', applicantId]);
}

// ---- responses ----

// a respondent's own response (null if none yet)
export async function myResponse(cycle, email) {
  email = lc(email);
  if (cloud.demo) return demoDb().responses[cycle + '|' + email] || null;
  try { const d = await cloud.docs.get(['selection', cycle, 'responses', email]); if (!d) return null; const { id: _id, serverAt: _s, ...v } = d; return v; }
  catch (e) { if (e?.code === 'permission-denied') return null; throw e; }
}
// -> 'sent' (the server has it) or 'waiting' (kept in this device's outbox: it goes by itself once back online); throws
// what the server said (the round closed, no access). Through app-sync's outbox (sync.js), never the SDK's own queue.
export async function sendResponse(round, user, name, answers) {
  const email = lc(user.email);
  const clean = cleanAnswers(round, answers);
  if (cloud.demo) { const d = demoDb(); d.responses[round.cycle + '|' + email] = { email, name, answers: clean, updatedAt: Date.now() }; demoWrite(d); return 'sent'; }
  const saving = await cloud.sending();
  return (await saving.send(round.cycle, { id: email, email, name, answers: clean })).state;
}

// admins and the committee: every response to a round
export async function listResponses(cycle) {
  if (cloud.demo) return Object.entries(demoDb().responses).filter(([k]) => k.startsWith(cycle + '|')).map(([, v]) => v);
  return (await cloud.docs.list(['selection', cycle, 'responses'])).docs.map(d => {
    const v = d.data; const t = v.updatedAt;
    const { id: _id, serverAt: _s, ...rest } = v;
    return { ...rest, updatedAt: t?.toMillis ? t.toMillis() : Number(t) || 0 };
  });
}

// The retention delete (admins): every response and photo of a round goes; the round itself stays (closed), so its title
// and applicants remain for the record until it is deleted too. Returns { responses, photos } counts.
export async function deleteRoundData(cycle) {
  if (cloud.demo) {
    const d = demoDb(); const out = { responses: 0, photos: 0 };
    for (const k of Object.keys(d.responses)) if (k.startsWith(cycle + '|')) { delete d.responses[k]; out.responses++; }
    for (const k of Object.keys(d.photos)) if (k.startsWith(cycle + '|')) { delete d.photos[k]; out.photos++; }
    demoWrite(d); return out;
  }
  const out = {};
  for (const sub of ['responses', 'photos']) out[sub] = await cloud.docs.removeAll(['selection', cycle, sub]);
  return out;
}

// the committee list (admins keep it; a member can check their own entry)
export async function listCommittee() {
  if (cloud.demo) return Object.entries(demoDb().committee).map(([email, v]) => ({ email, name: v.name || '' }));
  return (await cloud.docs.list(['selectionCommittee'])).docs.map(d => ({ email: d.id, name: d.data.name || '' }))
    .sort((a, b) => a.email.localeCompare(b.email));
}
export async function saveCommittee({ email, name }) {
  email = lc(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That doesn’t look like an email address.');
  const doc = { name: String(name || '').trim().slice(0, 200) };
  if (cloud.demo) { const d = demoDb(); d.committee[email] = doc; demoWrite(d); return; }
  await cloud.docs.set(['selectionCommittee', email], doc);
}
export async function removeCommittee(email) {
  email = lc(email);
  if (cloud.demo) { const d = demoDb(); delete d.committee[email]; demoWrite(d); return; }
  await cloud.docs.remove(['selectionCommittee', email]);
}

// the three sign-in passcodes the Worker accepts, set on the Set up page (admins); a role with none here uses the Worker's own secret
export async function listCodes() {
  if (cloud.demo) return { ...demoDb().codes };
  const out = {};
  for (const d of (await cloud.docs.list(['selectionCodes'])).docs) if (typeof d.data.code === 'string') out[d.id] = d.data.code;
  return out;
}
export async function saveCode(role, code) {
  code = String(code || '').trim();
  if (!['guest', 'setup', 'committee'].includes(role)) throw new Error('Unknown passcode.');
  if (cloud.demo) { const d = demoDb(); d.codes[role] = code; demoWrite(d); return; }
  await cloud.docs.set(['selectionCodes', role], { code, updatedAt: Date.now() });
}
