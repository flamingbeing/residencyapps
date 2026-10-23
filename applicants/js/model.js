// NUHS Residency Applications: the logic, free of page code so test/model.test.mjs can run it in Node.
// A "round" is one selection exercise (e.g. the 2027 intake): a title, the applicants to rate, the questions asked about each
// applicant and, optionally, where the answers go (a Google Form). Real applicant names are never in this repo: the admin
// pastes them in the app (published to the shared store, or shared as a private link: the round travels in the part of
// the link after #, which servers never see).

export const MAX_APPLICANTS = 200;
export const MAX_QUESTIONS = 8;
export const SCALE = [1, 2, 3, 4, 5];
// Tap-to-add words under every comment box. Single words only (the toggle matches whole words); edit this list to change them.
export const SUGGESTED_COMMENTS = ['hardworking', 'conscientious', 'teachable', 'reliable', 'team player', 'good communicator', 'proactive', 'calm', 'humble', 'motivated', 'punctual', 'needs supervision'];
export const INTRO = [
  'The selection exercise is starting soon. We would really appreciate your honest feedback on the applicants below. As successful applicants will form part of our family, we would like to gather insights and understanding of our applicants based on your interactions.',
  'Please give each applicant an overall suitability score from 1 (unsuitable) to 5 (best fit), and, where you can, comments with specific examples. If you haven’t worked with someone, one tap skips them.',
  'Your response is confidential, and we will keep it so.',
];
// What is asked about each applicant until the admin changes it (ids "score" and "comment" are what the first version of
// the app and the department's Google Form used, so earlier answers still fit).
export const DEFAULT_QUESTIONS = [
  { id: 'score', type: 'scale', label: 'Overall suitability for residency', low: 'Unsuitable', high: 'Best fit', required: true },
  { id: 'comment', type: 'text', label: 'Comments', hint: 'Strengths, weaknesses or concerns, with a specific example', required: false },
];

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (Number.isInteger(v) && v > 0 && v < 1e10 ? v : null);
const RESERVED = new Set(['na', 'v']);

// One name per line. Bullets, numbers and blank lines are dropped; repeats are ignored.
export function parseNames(text) {
  const seen = new Set(), out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push({ id: 'a' + (out.length + 1), name: line });
    if (out.length >= MAX_APPLICANTS) break;
  }
  return out;
}

// The questions: up to 8, each a 1-5 score (with the words at its two ends) or a free-text box; any may be required.
export function cleanQuestions(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_QUESTIONS.map(q => ({ ...q }));
  const seen = new Set(), out = [];
  for (const q of list.slice(0, MAX_QUESTIONS)) {
    const label = str(q?.label, 200);
    if (!label) continue;
    let id = str(q.id, 20).toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!id || RESERVED.has(id) || seen.has(id)) { let i = out.length + 1; while (seen.has('q' + i)) i++; id = 'q' + i; }
    seen.add(id);
    const type = q.type === 'scale' ? 'scale' : 'text';
    const item = { id, type, label, required: !!q.required };
    if (type === 'scale') { item.low = str(q.low, 30); item.high = str(q.high, 30); }
    else if (str(q.hint, 200)) item.hint = str(q.hint, 200);
    out.push(item);
  }
  return out.length ? out : DEFAULT_QUESTIONS.map(q => ({ ...q }));
}
export const scaleQuestions = round => round.questions.filter(q => q.type === 'scale');

// Checks a round that was pasted or arrived in a link; returns a clean copy, or null.
// form (optional): { id, nameEntry } the Google Form's public id and the respondent-name field; each applicant may carry
// entry: { score, comment }, the numeric ids of that applicant's two fields in the form (only with the default questions).
export function cleanRound(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.applicants)) return null;
  const seen = new Set();
  const applicants = [];
  for (const a of r.applicants.slice(0, MAX_APPLICANTS)) {
    const name = str(a?.name, 120);
    const id = str(a?.id, 20) || 'a' + (applicants.length + 1);
    if (!name || seen.has(id)) continue;
    seen.add(id);
    const e = a.entry && num(a.entry.score) && num(a.entry.comment) ? { score: a.entry.score, comment: a.entry.comment } : null;
    applicants.push(e ? { id, name, entry: e } : { id, name });
  }
  if (!applicants.length) return null;
  const out = { v: 2, title: str(r.title, 200) || 'Applicant feedback', cycle: str(r.cycle, 20) || 'round', applicants, questions: cleanQuestions(r.questions) };
  const f = r.form;
  if (f && /^[A-Za-z0-9_-]{20,80}$/.test(f.id || '') && num(f.nameEntry) && applicants.every(a => a.entry)) out.form = { id: f.id, nameEntry: f.nameEntry };
  if (r.mirror === true && canMirror(out)) out.mirror = true;
  return out;
}

// Mirror (published rounds): each answer is also posted to the Google Form, which stays the source of truth; the shared store is the
// backup. Only for a round wired to a form whose questions are the standard two (the form has exactly those fields per applicant).
export const canMirror = round => !!round?.form && Array.isArray(round.questions) && round.questions.length === 2
  && round.questions[0].id === 'score' && round.questions[0].type === 'scale' && round.questions[1].id === 'comment' && round.questions[1].type === 'text';

// A round as text in a link: base64url of the JSON (names may be non-ASCII).
export function encodeRound(round) {
  const bytes = new TextEncoder().encode(JSON.stringify(round));
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeRound(s) {
  try {
    const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return cleanRound(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))));
  } catch { return null; }
}
// Accepts pasted JSON, a whole link, or just the part after #r=.
export function readRoundText(text) {
  const t = String(text || '').trim();
  if (t.startsWith('{')) { try { return cleanRound(JSON.parse(t)); } catch { return null; } }
  const m = t.match(/#r=([A-Za-z0-9_-]+)/);
  return decodeRound(m ? m[1] : t);
}

// ---- one respondent's answers: { [applicantId]: { na: bool, [questionId]: 1-5 | text } } ----

const isAnswered = (q, v) => (q.type === 'scale' ? Number.isInteger(v) && v >= 1 && v <= 5 : typeof v === 'string' && v.trim() !== '');
export const hasAnswer = (round, r) => !!r && round.questions.some(q => isAnswered(q, r[q.id]));
export const blank = () => ({ na: false });
export function cleanAnswers(round, raw) {
  const out = {};
  for (const a of round.applicants) {
    const r = raw && raw[a.id] || {};
    const o = { na: false };
    for (const q of round.questions) {
      const v = r[q.id];
      if (q.type === 'scale') { if (Number.isInteger(v) && v >= 1 && v <= 5) o[q.id] = v; }
      else if (typeof v === 'string' && v.trim()) o[q.id] = v.slice(0, 5000);
    }
    o.na = !!r.na && !hasAnswer(round, o);   // answering someone cancels "haven't worked with them"
    out[a.id] = o;
  }
  return out;
}
// 'skipped' (hasn't worked with them), 'done' (something answered, every required question answered), 'partial', 'todo'
export function statusOf(round, r) {
  if (!r) return 'todo';
  if (r.na) return 'skipped';
  if (!hasAnswer(round, r)) return 'todo';
  return round.questions.every(q => !q.required || isAnswered(q, r[q.id])) ? 'done' : 'partial';
}
export function progress(round, answers) {
  const n = { done: 0, partial: 0, skipped: 0, todo: 0 };
  for (const a of round.applicants) n[statusOf(round, answers[a.id])]++;
  return { ...n, total: round.applicants.length, finished: n.done + n.skipped };
}
// The first applicant after position `from` (default: from the start) that still needs an answer, wrapping round; null when none.
export function nextUnanswered(round, answers, from = -1) {
  const n = round.applicants.length;
  for (let k = 1; k <= n; k++) {
    const x = round.applicants[(from + k + n) % n];
    const st = statusOf(round, answers[x.id]);
    if (st === 'todo' || st === 'partial') return x;
  }
  return null;
}
// Things worth a second look before sending. Never blocks sending; a comment is never needed on its own (only a question
// the admin marked required is chased, and not for people marked "haven't worked with them").
export function warnings(round, answers) {
  const w = [];
  for (const a of round.applicants) {
    const r = answers[a.id];
    const s = statusOf(round, r);
    if (s === 'todo') w.push({ id: a.id, name: a.name, text: 'not answered yet' });
    else if (s === 'partial') w.push({ id: a.id, name: a.name, text: 'still needs: ' + round.questions.filter(q => q.required && !isAnswered(q, r[q.id])).map(q => q.label).join(', ') });
  }
  return w;
}

// ---- sending ----

// The body for the Google Form's formResponse address (one field per question; only with the default questions).
export function formBody(round, respondent, answers) {
  const p = new URLSearchParams();
  p.set('entry.' + round.form.nameEntry, respondent);
  for (const a of round.applicants) {
    const r = answers[a.id];
    if (!r || r.na) continue;
    if (r.score) p.set('entry.' + a.entry.score, String(r.score));
    if (typeof r.comment === 'string' && r.comment.trim()) p.set('entry.' + a.entry.comment, r.comment.trim());
  }
  return p;
}
export const formUrl = round => `https://docs.google.com/forms/d/e/${round.form.id}/formResponse`;

// What the respondent can copy or keep.
export function answersText(round, respondent, answers) {
  const lines = [round.title, `From: ${respondent}`, ''];
  for (const a of round.applicants) {
    const r = answers[a.id];
    const s = statusOf(round, r);
    if (s === 'todo') continue;
    lines.push(a.name);
    if (r.na) lines.push('Did not work with them');
    else for (const q of round.questions) if (isAnswered(q, r[q.id])) lines.push(`${q.label}: ${r[q.id]}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

// ---- results (PDs and the committee): subs = [{ by, name, at, answers }] ----

export function summary(round, subs) {
  return round.applicants.map(a => {
    const scales = scaleQuestions(round).map(q => ({ id: q.id, label: q.label, n: 0, sum: 0, mean: null }));
    const comments = [];
    let skipped = 0, answered = 0;
    for (const s of subs) {
      const r = s.answers[a.id];
      if (!r) continue;
      if (r.na) skipped++;
      if (hasAnswer(round, r)) answered++;
      for (const sc of scales) if (Number.isInteger(r[sc.id])) { sc.n++; sc.sum += r[sc.id]; }
      for (const q of round.questions) if (q.type === 'text' && typeof r[q.id] === 'string' && r[q.id].trim()) comments.push({ by: s.name, q: q.label, text: r[q.id].trim() });
    }
    for (const sc of scales) { if (sc.n) sc.mean = sc.sum / sc.n; delete sc.sum; }
    return { id: a.id, name: a.name, scales, skipped, answered, comments };
  });
}
const cell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // a spreadsheet must not run a comment as a formula
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// One row per answer: applicant, respondent, sent, question, answer
export function resultsCSV(round, subs) {
  const rows = [['applicant', 'respondent', 'sent', 'question', 'answer']];
  for (const s of subs) for (const a of round.applicants) {
    const r = s.answers[a.id];
    const st = statusOf(round, r);
    if (st === 'todo') continue;
    const when = new Date(s.at).toISOString();
    if (r.na) { rows.push([a.name, s.name, when, '(did not work with them)', 'yes']); continue; }
    for (const q of round.questions) if (isAnswered(q, r[q.id])) rows.push([a.name, s.name, when, q.label, r[q.id]]);
  }
  return rows.map(r => r.map(cell).join(',')).join('\n') + '\n';
}

// ---- photos: the stored form is the base64 JPEG only (see rules: selection/{cycle}/photos/{id}.jpeg) ----

export const MAX_PHOTO_B64 = 80000;
export const photoSrc = jpeg => (typeof jpeg === 'string' && jpeg && jpeg.length <= MAX_PHOTO_B64 && /^[A-Za-z0-9+/=]+$/.test(jpeg) ? 'data:image/jpeg;base64,' + jpeg : null);
// Which applicant a photo file belongs to, by its file name: "lim-zhan-foong.jpg" or "Lim Zhan Foong 2.png" match "Lim Zhan Foong".
export function matchPhotoFile(round, fileName) {
  const norm = s => String(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z]+/g, '');
  const f = norm(fileName);
  if (!f) return null;
  const exact = round.applicants.filter(a => norm(a.name) === f);
  if (exact.length === 1) return exact[0];
  const hits = round.applicants.filter(a => { const n = norm(a.name); return n && (f.startsWith(n) || n.startsWith(f) && f.length >= 6); });
  return hits.length === 1 ? hits[0] : null;
}

// ---- demo round (made-up names only) ----

export const DEMO_NAMES = ['Alex Demo', 'Bao Sample', 'Casey Example', 'Dani Placeholder', 'Eli Test', 'Fern Mockup', 'Gus Specimen', 'Hana Template'];
export function demoRound() {
  return { v: 2, title: 'Applicant feedback (demo)', cycle: 'demo', applicants: DEMO_NAMES.map((name, i) => ({ id: 'a' + (i + 1), name })), questions: DEFAULT_QUESTIONS.map(q => ({ ...q })) };
}
// A passport-shaped placeholder picture (SVG, not a real person) for the demo.
export function demoPhoto(i) {
  const bg = ['#cfe3f4', '#f6dcc0', '#d7ead2', '#ead3e6', '#f2e6b8', '#cdeae6', '#e5d6c8', '#d8dcf2'][i % 8];
  const skin = ['#e8b894', '#c68c64', '#f1cfae', '#a86f4a', '#d9a47c', '#8d5a3b', '#f4d9bd', '#b9835a'][i % 8];
  const shirt = ['#2f5d8a', '#7a2f3a', '#3b6b4f', '#4b4a6b', '#6b5a2f', '#2f6b6b', '#5a3b2f', '#3b3f6b'][i % 8];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 270"><rect width="210" height="270" fill="${bg}"/><path d="M20 270c4-52 38-72 85-72s81 20 85 72z" fill="${shirt}"/><rect x="88" y="150" width="34" height="50" rx="12" fill="${skin}"/><ellipse cx="105" cy="108" rx="40" ry="50" fill="${skin}"/></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// ---- the three sign-in passcodes (Set up page; worker/guest.js checks them) ----
export const CODE_ROLES = [
  { id: 'guest', label: 'Guest', what: 'Sends feedback: residents, faculty and anyone else asked to answer.' },
  { id: 'setup', label: 'Set up', what: 'Opens Set up: the round, photos and questions.' },
  { id: 'committee', label: 'Committee', what: 'Reads the Results: every response and who said what.' },
];
export const CODE_MIN = 6, CODE_MAX = 100;
// a readable random passcode like "k7mq-x4ph-9d2t": no look-alikes (0/o, 1/l/i); `bytes` is injectable for tests
export function newPasscode(bytes = globalThis.crypto.getRandomValues(new Uint8Array(12))) {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const c = Array.from(bytes, b => A[b % A.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}
// why a passcode can't be used for `role`, or '' when it can. `others` is { role: code } for the other roles that have one stored.
// Passcodes ignore capitals and surrounding spaces (worker/guest.js), so two roles can't share one: the Worker would pick the first.
export function codeProblem(role, code, others = {}) {
  const c = String(code || '').trim().toLowerCase();
  if (c.length < CODE_MIN) return `Use at least ${CODE_MIN} characters.`;
  if (c.length > CODE_MAX) return `Use at most ${CODE_MAX} characters.`;
  for (const [r, o] of Object.entries(others)) if (r !== role && o && String(o).trim().toLowerCase() === c) return `That is already the ${CODE_ROLES.find(x => x.id === r)?.label.toLowerCase() || r} passcode. Each one must be different.`;
  return '';
}

// ---- open and close dates (published rounds) ----

// 'before' (opensAt still to come), 'open', 'after' (closesAt passed) or 'closed' (closed by hand). The rules apply the same
// test with the server's clock, so a phone with the wrong time can't get round it.
export function roundState(round, now = Date.now()) {
  if (!round) return 'closed';
  if (round.shared && round.status === 'closed') return 'closed';
  if (round.opensAt != null && now < round.opensAt) return 'before';
  if (round.closesAt != null && now >= round.closesAt) return 'after';
  return 'open';
}
// <input type="datetime-local"> value <-> ms, in the phone's own time zone ('' and bad input are null)
export function toLocalInput(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const t = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(t) ? t : null;
}
// '23 Oct 2026, 17:00'
export const fmtWhen = ms => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
