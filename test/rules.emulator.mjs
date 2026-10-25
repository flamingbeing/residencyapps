// Firestore rules checks (firestore.rules) against the local emulator, fake accounts only. Run from the repo root:
//   bash tools/test-rules.sh
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, getDocs, collection, deleteDoc, serverTimestamp, runTransaction } from 'firebase/firestore';
import fs from 'node:fs';

const env = await initializeTestEnvironment({
  projectId: 'demo-residencyapps',
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});
const as = (email, verified = true) => env.authenticatedContext(email, { email, email_verified: verified }).firestore();
const code = (uid, role) => env.authenticatedContext(uid, role ? { guest: true, role } : { guest: true }).firestore();
const ADMIN = 'boss@example.com', COM = 'dr.committee@example.com', STRANGER = 'stranger@example.com';
const HOUR = 36e5;
const round = (o = {}) => ({ cycle: 'c1', title: 'Round', status: 'open', applicants: [{ id: 'a1', name: 'Applicant One' }], updatedAt: 1, ...o });
const resp = (id, o = {}) => ({ email: id, name: 'Someone', answers: { a1: { score: 4, comment: 'Good', na: false } }, updatedAt: serverTimestamp(), ...o });
const photo = (o = {}) => ({ jpeg: '/9j/4AAQSkZJRg==', updatedAt: 1, ...o });
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'admins', ADMIN), { name: 'Boss' });
  await setDoc(doc(db, 'selectionCommittee', COM), { name: 'Dr Committee' });
  await setDoc(doc(db, 'selection', 'c1'), round());
  await setDoc(doc(db, 'selection', 'old'), round({ cycle: 'old', status: 'closed' }));
  await setDoc(doc(db, 'selection', 'ended'), round({ cycle: 'ended', closesAt: Date.now() - HOUR }));
  await setDoc(doc(db, 'selection', 'later'), round({ cycle: 'later', opensAt: Date.now() + HOUR }));
  await setDoc(doc(db, 'selection', 'window'), round({ cycle: 'window', opensAt: Date.now() - HOUR, closesAt: Date.now() + HOUR }));
  await setDoc(doc(db, 'selection', 'c1', 'photos', 'a1'), photo());
  // an answer copied from the app's first home, keyed by email
  await setDoc(doc(db, 'selection', 'c1', 'responses', 'alice@example.com'), resp('alice@example.com', { updatedAt: 1 }));
});
let n = 0, fail = 0;
async function t(name, p) { n++; try { await p; } catch (e) { fail++; console.log('FAIL', name, e.message.slice(0, 300)); } }
const adm = as(ADMIN), com = as(COM), str = as(STRANGER), unverified = as(ADMIN, false);
const anon = env.unauthenticatedContext().firestore();
const g1 = code('g1', 'guest'), g2 = code('g2', 'guest'), oldGuest = code('g9'), su = code('s1', 'setup'), cm = code('c1', 'committee');

// ---- who reads a round ----
for (const [who, db] of [['guest', g1], ['old guest token', oldGuest], ['set-up code', su], ['committee code', cm], ['admin', adm], ['committee member', com]]) {
  await t(`${who} reads a round`, assertSucceeds(getDoc(doc(db, 'selection', 'c1'))));
  await t(`${who} reads a photo`, assertSucceeds(getDoc(doc(db, 'selection', 'c1', 'photos', 'a1'))));
}
await t('guest lists rounds', assertSucceeds(getDocs(collection(g1, 'selection'))));
for (const [who, db] of [['stranger', str], ['signed-out visitor', anon], ['unverified admin email', unverified]]) {
  await t(`${who} cannot read a round`, assertFails(getDoc(doc(db, 'selection', 'c1'))));
  await t(`${who} cannot read a photo`, assertFails(getDoc(doc(db, 'selection', 'c1', 'photos', 'a1'))));
}
await t('a token with an unknown role is nothing', assertFails(getDoc(doc(code('z1', 'boss'), 'selection', 'c1'))));
await t('a guest claim with an email is no passcode account', assertFails(getDoc(doc(env.authenticatedContext('x', { guest: true, email: 'x@example.com' }).firestore(), 'selection', 'c1'))));

// ---- who sets a round up ----
await t('set-up code creates a round', assertSucceeds(setDoc(doc(su, 'selection', 'c2'), round({ cycle: 'c2' }))));
await t('admin updates a round', assertSucceeds(setDoc(doc(adm, 'selection', 'c2'), round({ cycle: 'c2', status: 'closed' }))));
await t('a round with open and close dates', assertSucceeds(setDoc(doc(su, 'selection', 'c3'), round({ cycle: 'c3', opensAt: 1, closesAt: 2 }))));
await t('dates must be numbers', assertFails(setDoc(doc(su, 'selection', 'c3'), round({ cycle: 'c3', closesAt: 'soon' }))));
await t('a round wired to a form with mirror on', assertSucceeds(setDoc(doc(adm, 'selection', 'c4'), round({ cycle: 'c4', form: { id: 'f'.repeat(30), nameEntry: 7 }, mirror: true }))));
await t('a malformed form or mirror is refused', assertFails(setDoc(doc(adm, 'selection', 'c5'), round({ cycle: 'c5', form: { id: 'f'.repeat(30), nameEntry: 7, extra: 1 }, mirror: 'yes' }))));
for (const [who, db] of [['guest', g1], ['committee code', cm], ['committee member', com], ['stranger', str]]) await t(`${who} cannot change a round`, assertFails(setDoc(doc(db, 'selection', 'c1'), round({ title: 'Mine' }))));
await t('round id must match', assertFails(setDoc(doc(adm, 'selection', 'c6'), round({ cycle: 'other' }))));
await t('round needs applicants', assertFails(setDoc(doc(adm, 'selection', 'c6'), round({ cycle: 'c6', applicants: [] }))));
await t('round status is checked', assertFails(setDoc(doc(adm, 'selection', 'c6'), round({ cycle: 'c6', status: 'maybe' }))));
await t('round takes no extra fields', assertFails(setDoc(doc(adm, 'selection', 'c6'), round({ cycle: 'c6', secret: 1 }))));
await t('round with questions', assertSucceeds(setDoc(doc(adm, 'selection', 'q1'), round({ cycle: 'q1', questions: [{ id: 'score', type: 'scale', label: 'Score', required: true }] }))));
await t('too many questions', assertFails(setDoc(doc(adm, 'selection', 'q2'), round({ cycle: 'q2', questions: Array.from({ length: 11 }, (_, i) => ({ id: 'q' + i, type: 'text', label: 'x' })) }))));
await t('empty question list', assertFails(setDoc(doc(adm, 'selection', 'q4'), round({ cycle: 'q4', questions: [] }))));
await t('set-up code cannot delete a round', assertFails(deleteDoc(doc(su, 'selection', 'c2'))));
await t('admin deletes a round', assertSucceeds(deleteDoc(doc(adm, 'selection', 'c2'))));

// ---- photos ----
await t('set-up code adds a photo', assertSucceeds(setDoc(doc(su, 'selection', 'c1', 'photos', 'a2'), photo())));
await t('admin replaces a photo', assertSucceeds(setDoc(doc(adm, 'selection', 'c1', 'photos', 'a2'), photo({ updatedAt: 2 }))));
for (const [who, db] of [['guest', g1], ['committee code', cm], ['committee member', com]]) await t(`${who} cannot add a photo`, assertFails(setDoc(doc(db, 'selection', 'c1', 'photos', 'a3'), photo())));
await t('photo takes no extra fields', assertFails(setDoc(doc(adm, 'selection', 'c1', 'photos', 'a3'), photo({ note: 'x' }))));
await t('photo cannot be empty', assertFails(setDoc(doc(adm, 'selection', 'c1', 'photos', 'a3'), photo({ jpeg: '' }))));
await t('photo size limit', assertFails(setDoc(doc(adm, 'selection', 'c1', 'photos', 'a3'), photo({ jpeg: 'A'.repeat(80001) }))));
await t('photo at the size limit', assertSucceeds(setDoc(doc(adm, 'selection', 'c1', 'photos', 'a3'), photo({ jpeg: 'A'.repeat(80000) }))));
await t('set-up code removes a photo', assertSucceeds(deleteDoc(doc(su, 'selection', 'c1', 'photos', 'a3'))));
await t('guest cannot remove a photo', assertFails(deleteDoc(doc(g1, 'selection', 'c1', 'photos', 'a1'))));

// ---- responses: guests send, the committee and admins read ----
await t('guest sends their own response', assertSucceeds(setDoc(doc(g1, 'selection', 'c1', 'responses', 'guest-g1'), resp('guest-g1', { name: 'Anonymous' }))));
await t('guest changes it while open', assertSucceeds(setDoc(doc(g1, 'selection', 'c1', 'responses', 'guest-g1'), resp('guest-g1'))));
await t('an old guest token sends too', assertSucceeds(setDoc(doc(oldGuest, 'selection', 'c1', 'responses', 'guest-g9'), resp('guest-g9'))));
await t('guest reads their own response', assertSucceeds(getDoc(doc(g1, 'selection', 'c1', 'responses', 'guest-g1'))));
await t('guest cannot read another guest', assertFails(getDoc(doc(g2, 'selection', 'c1', 'responses', 'guest-g1'))));
await t('guest cannot write as another guest', assertFails(setDoc(doc(g2, 'selection', 'c1', 'responses', 'guest-g1'), resp('guest-g1'))));
await t('guest cannot write under an email', assertFails(setDoc(doc(g1, 'selection', 'c1', 'responses', 'alice@example.com'), resp('alice@example.com'))));
await t('guest cannot claim another id in the body', assertFails(setDoc(doc(g2, 'selection', 'c1', 'responses', 'guest-g2'), resp('guest-g1'))));
await t('guest cannot list responses', assertFails(getDocs(collection(g1, 'selection', 'c1', 'responses'))));
await t('no answers to a closed round', assertFails(setDoc(doc(g1, 'selection', 'old', 'responses', 'guest-g1'), resp('guest-g1'))));
await t('no answers after closesAt', assertFails(setDoc(doc(g1, 'selection', 'ended', 'responses', 'guest-g1'), resp('guest-g1'))));
await t('no answers before opensAt', assertFails(setDoc(doc(g1, 'selection', 'later', 'responses', 'guest-g1'), resp('guest-g1'))));
await t('answers inside the dates', assertSucceeds(setDoc(doc(g1, 'selection', 'window', 'responses', 'guest-g1'), resp('guest-g1'))));
await t('updatedAt must be the server time', assertFails(setDoc(doc(g2, 'selection', 'c1', 'responses', 'guest-g2'), resp('guest-g2', { updatedAt: 5 }))));
await t('response takes no extra fields', assertFails(setDoc(doc(g2, 'selection', 'c1', 'responses', 'guest-g2'), resp('guest-g2', { extra: 1 }))));
await t('response needs a name', assertFails(setDoc(doc(g2, 'selection', 'c1', 'responses', 'guest-g2'), resp('guest-g2', { name: '' }))));
// sent through app-sync's outbox (applicants/js/sync.js): id, updatedAt the device's ms, serverAt the server's time, in a transaction
const viaSync = (id, o = {}) => ({ ...resp(id), id, updatedAt: Date.now(), serverAt: serverTimestamp(), ...o });
const txSend = (db, cycle, id, data) => runTransaction(db, async tx => { const ref = doc(db, 'selection', cycle, 'responses', id); await tx.get(ref); tx.set(ref, data); });
await t('guest sends through the outbox (transaction, serverAt)', assertSucceeds(txSend(g2, 'c1', 'guest-g2', viaSync('guest-g2'))));
await t('guest sends again through the outbox', assertSucceeds(txSend(g2, 'c1', 'guest-g2', viaSync('guest-g2', { name: 'Dr Two' }))));
await t('the old shape still works beside it', assertSucceeds(setDoc(doc(g2, 'selection', 'c1', 'responses', 'guest-g2'), resp('guest-g2'))));
await t('serverAt must be the server time', assertFails(txSend(g2, 'c1', 'guest-g2', viaSync('guest-g2', { serverAt: 5 }))));
await t('with serverAt, updatedAt is a number', assertFails(txSend(g2, 'c1', 'guest-g2', viaSync('guest-g2', { updatedAt: 'now' }))));
await t('the id in the body is the document’s', assertFails(txSend(g2, 'c1', 'guest-g2', viaSync('guest-g2', { id: 'guest-g1' }))));
await t('no outbox answers to a closed round', assertFails(txSend(g2, 'old', 'guest-g2', viaSync('guest-g2'))));
for (const [who, db, id] of [['set-up code', su, 'guest-s1'], ['committee code', cm, 'guest-c1'], ['admin', adm, 'guest-boss'], ['committee member', com, COM], ['stranger', str, STRANGER]])
  await t(`${who} cannot send a response`, assertFails(setDoc(doc(db, 'selection', 'c1', 'responses', id), resp(id))));
await t('set-up code cannot read responses', assertFails(getDocs(collection(su, 'selection', 'c1', 'responses'))));
await t('set-up code cannot read one response', assertFails(getDoc(doc(su, 'selection', 'c1', 'responses', 'guest-g1'))));
for (const [who, db] of [['committee code', cm], ['committee member', com], ['admin', adm]]) {
  await t(`${who} lists responses`, assertSucceeds(getDocs(collection(db, 'selection', 'c1', 'responses'))));
  await t(`${who} reads an answer copied under an email`, assertSucceeds(getDoc(doc(db, 'selection', 'c1', 'responses', 'alice@example.com'))));
}
await t('committee code cannot edit a response', assertFails(setDoc(doc(cm, 'selection', 'c1', 'responses', 'guest-g1'), resp('guest-g1'))));

// ---- the retention delete: admins only ----
for (const [who, db] of [['guest', g1], ['set-up code', su], ['committee code', cm], ['committee member', com]])
  await t(`${who} cannot delete a response`, assertFails(deleteDoc(doc(db, 'selection', 'c1', 'responses', 'guest-g1'))));
await t('admin deletes a response', assertSucceeds(deleteDoc(doc(adm, 'selection', 'c1', 'responses', 'guest-g1'))));
await t('admin deletes a photo', assertSucceeds(deleteDoc(doc(adm, 'selection', 'c1', 'photos', 'a2'))));

// ---- admins and the committee list ----
await t('admin checks own admin entry', assertSucceeds(getDoc(doc(adm, 'admins', ADMIN))));
await t('a stranger checks they are no admin', assertSucceeds(getDoc(doc(str, 'admins', STRANGER))));
await t('nobody reads another admin entry', assertFails(getDoc(doc(str, 'admins', ADMIN))));
await t('nobody lists admins', assertFails(getDocs(collection(adm, 'admins'))));
for (const [who, db] of [['admin', adm], ['guest', g1], ['set-up code', su]]) await t(`${who} cannot add an admin`, assertFails(setDoc(doc(db, 'admins', 'x@example.com'), { name: 'x' })));
await t('member checks own committee entry', assertSucceeds(getDoc(doc(com, 'selectionCommittee', COM))));
await t('admin lists the committee', assertSucceeds(getDocs(collection(adm, 'selectionCommittee'))));
await t('admin adds a committee member', assertSucceeds(setDoc(doc(adm, 'selectionCommittee', 'new@example.com'), { name: 'New' })));
await t('admin removes a committee member', assertSucceeds(deleteDoc(doc(adm, 'selectionCommittee', 'new@example.com'))));
await t('committee emails are lower case', assertFails(setDoc(doc(adm, 'selectionCommittee', 'Mixed@Example.com'), { name: 'x' })));
await t('committee entry takes only a name', assertFails(setDoc(doc(adm, 'selectionCommittee', 'y@example.com'), { name: 'y', role: 'admin' })));
for (const [who, db] of [['guest', g1], ['set-up code', su], ['committee code', cm], ['committee member', com], ['stranger', str]]) {
  await t(`${who} cannot list the committee`, assertFails(getDocs(collection(db, 'selectionCommittee'))));
  await t(`${who} cannot join the committee`, assertFails(setDoc(doc(db, 'selectionCommittee', 'me@example.com'), { name: 'me' })));
}

// ---- the three passcodes ----
const reader = env.authenticatedContext('codes-reader', { codesReader: true }).firestore();
const codeDoc = (c = 'maple-tree-42') => ({ code: c, updatedAt: 1 });
await t('admin sets a passcode', assertSucceeds(setDoc(doc(adm, 'selectionCodes', 'guest'), codeDoc())));
await t('admin sets the setup passcode', assertSucceeds(setDoc(doc(adm, 'selectionCodes', 'setup'), codeDoc('lantern-9-glow'))));
await t('admin reads every passcode', assertSucceeds(getDocs(collection(adm, 'selectionCodes'))));
await t('the Worker service sign-in reads a passcode', assertSucceeds(getDoc(doc(reader, 'selectionCodes', 'guest'))));
await t('the Worker service sign-in lists passcodes', assertSucceeds(getDocs(collection(reader, 'selectionCodes'))));
await t('the Worker service sign-in cannot write one', assertFails(setDoc(doc(reader, 'selectionCodes', 'guest'), codeDoc('other-code-1'))));
await t('the Worker service sign-in cannot read rounds', assertFails(getDoc(doc(reader, 'selection', 'c1'))));
await t('a claim with an email is no service sign-in', assertFails(getDoc(doc(env.authenticatedContext('x', { codesReader: true, email: 'x@example.com' }).firestore(), 'selectionCodes', 'guest'))));
for (const [who, db] of [['committee member', com], ['stranger', str], ['signed-out visitor', anon], ['guest', g1], ['set-up code', su], ['committee code', cm]]) {
  await t(`${who} cannot read a passcode`, assertFails(getDoc(doc(db, 'selectionCodes', 'guest'))));
  await t(`${who} cannot set a passcode`, assertFails(setDoc(doc(db, 'selectionCodes', 'guest'), codeDoc('sneaky-code-1'))));
  await t(`${who} cannot clear a passcode`, assertFails(deleteDoc(doc(db, 'selectionCodes', 'guest'))));
}
await t('a passcode needs at least 6 characters', assertFails(setDoc(doc(adm, 'selectionCodes', 'guest'), codeDoc('abc12'))));
await t('a passcode is at most 100 characters', assertFails(setDoc(doc(adm, 'selectionCodes', 'guest'), codeDoc('a'.repeat(101)))));
await t('a passcode takes no extra fields', assertFails(setDoc(doc(adm, 'selectionCodes', 'guest'), { ...codeDoc(), role: 'admin' })));
await t('only the three roles have a passcode', assertFails(setDoc(doc(adm, 'selectionCodes', 'admin'), codeDoc())));
await t('admin clears a passcode', assertSucceeds(deleteDoc(doc(adm, 'selectionCodes', 'setup'))));

await env.cleanup();
console.log(fail ? `rules: ${fail} of ${n} checks failed` : `rules: ${n} checks passed`);
process.exit(fail ? 1 : 0);
