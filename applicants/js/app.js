// NUHS Residency Applications: confidential feedback on residency applicants (a 1-5 suitability score and a comment each,
// or the questions the round sets). Everyone signs in with a passcode (guest: answers; set-up: the round; committee: the
// results); admins sign in with Google (cloud.js). The round, photos and answers live in Firestore (store.js); all the logic
// that needs no page is in model.js.
// A round can also travel as a private link (#r=…) with answers kept on the device or posted to a Google Form (the first
// version of the app); a published round is the normal way.
// With ?demo: made-up applicants, a demo sign-in per role, and nothing leaves the browser.

import * as cloud from './cloud.js';
import { h, fill, toast, modal, confirmBox, download, empty, applyTheme, errText, initials, debounce, segment } from './ui.js';
import {
  INTRO, SCALE, SUGGESTED_COMMENTS, DEFAULT_QUESTIONS, MAX_QUESTIONS, parseNames, cleanRound, cleanQuestions, encodeRound, readRoundText, cleanAnswers, blank, statusOf,
  progress, nextUnanswered, warnings, formBody, formUrl, answersText, summary, resultsCSV, demoRound, matchPhotoFile, photoSrc, canMirror, scaleQuestions, hasAnswer,
  CODE_ROLES, newPasscode, codeProblem, roundState, toLocalInput, fromLocalInput, fmtWhen,
} from './model.js';
import * as store from './store.js';
import { passportJpeg } from './photo.js';
import { startUpdates, retryUpdate } from './app-update.js';

// who is signed in: { email, name, uid, guest?, role? } (cloud.js), and a Google sign-in's { admin, committee }
const S = { user: null, roles: { admin: false, committee: false } };

applyTheme();
if (cloud.demo && /[?&]demo=reset/.test(location.search)) store.resetDemo();   // the demo goes back to its made-up start

const app = document.getElementById('app');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('sub');
const backEl = document.getElementById('back');
const meEl = document.getElementById('me');

// ---------- on-device storage (the demo keeps its own, apart from any real round) ----------

const NS = cloud.demo ? 'sel-demo' : 'sel';
const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const del = k => { try { localStorage.removeItem(k); } catch {} };
const K = { round: `${NS}-round`, ans: (c, e) => `${NS}-ans-${c}-${e}`, subs: c => `${NS}-subs-${c}` };

let round = null;      // the open round, or null
let answers = {};      // this respondent's answers, by applicant id
let sent = null;       // { at, via } once this respondent sent
let photos = {};       // applicant id -> picture (published rounds only)

// A round link: the round travels after #r= . Read it before anything else so it survives sign-in.
(function takeLink() {
  const m = location.hash.match(/^#r=([A-Za-z0-9_-]+)/);
  if (!m) return;
  const r = readRoundText(m[1]);
  history.replaceState(null, '', location.pathname + location.search + '#');
  if (r) { put(K.round, r); setTimeout(() => toast('Round opened: ' + r.title), 400); }
  else setTimeout(() => toast('That link didn’t work. Ask for a new one.'), 400);
})();

// The round: the open one in the shared store, else the newest closed one (staff and the committee still read it), else
// one that came in a link or was set up on this device.
async function loadRound() {
  let shared = null;
  if (S.user && mayIn()) { try { const all = await store.listRounds(); shared = all.find(r => r.status === 'open') || all[0] || null; } catch (e) { console.warn('Shared rounds unavailable', e); } }
  round = shared || cleanRound(get(K.round, null)) || (cloud.demo ? demoRound() : null);
  photos = {};
  if (round?.shared) { try { photos = await store.listPhotos(round.cycle); } catch (e) { console.warn('Photos unavailable', e); } }
}
async function loadMine() {
  answers = {}; sent = null;
  if (!round || !S.user) return;
  const mine = get(K.ans(round.cycle, S.user.email), {});
  answers = cleanAnswers(round, mine.a);
  sent = mine.sent || null;
  if (round.shared) {
    try {
      const r = await store.myResponse(round.cycle, S.user.email);
      if (r) { sent = { at: Number(r.updatedAt?.toMillis ? r.updatedAt.toMillis() : r.updatedAt) || Date.now(), via: 'store' }; if (!mine.a) answers = cleanAnswers(round, r.answers); }
      else if (sent?.via === 'store') sent = null;
    } catch (e) { console.warn('Couldn’t check for a sent response', e); }
  }
}
const saveMine = () => put(K.ans(round.cycle, S.user.email), { a: answers, sent });
// a passcode sign-in (no email): 'guest' sends feedback, 'setup' sets the round up, 'committee' reads the results
const codeRole = () => (S.user?.guest ? S.user.role || 'guest' : null);
const isGuest = () => codeRole() === 'guest';
const isAdmin = () => !!S.roles.admin;
const isStaff = () => isAdmin() || codeRole() === 'setup';
const canAnswer = () => isGuest();
const canResults = () => isAdmin() || !!S.roles.committee || codeRole() === 'committee';
const mayIn = () => !!codeRole() || isAdmin() || !!S.roles.committee;
const subs = () => (round && !round.shared ? get(K.subs(round.cycle), []) : []);
const isOpen = () => roundState(round) === 'open';
// why answers can't be sent now, in a sentence (or '')
const shutText = () => ({ before: `This round opens on ${round?.opensAt ? fmtWhen(round.opensAt) : 'a later date'}. You can look, but answers can’t be sent yet.`,
  after: 'This round has closed. You can still look at your answers, but they can’t be sent any more.',
  closed: 'This round is closed. You can still look at your answers, but they can’t be sent any more.' })[roundState(round)] || '';

// ---------- routing ----------

const route = () => {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (canAnswer() && a === 'a' && round?.applicants.some(x => x.id === b)) return { name: 'a', id: b };
  if (canAnswer() && ['review', 'done'].includes(a)) return { name: a };
  if ((a === 'setup' && isStaff()) || (a === 'results' && canResults())) return { name: a };
  // a set-up or committee passcode doesn't answer: it opens its own page
  if (!canAnswer()) return { name: canResults() ? 'results' : 'setup' };
  return { name: 'home' };
};
const go = hash => { location.hash = hash; };

function header(title, { back = false } = {}) {
  titleEl.textContent = title;
  document.title = title === 'NUHS Residency Applications' ? title : `${title} · NUHS Residency Applications`;
  subEl.textContent = 'Demo'; subEl.hidden = !cloud.demo;
  backEl.hidden = !back;
  backEl.onclick = () => { history.length > 1 && route().name !== 'home' ? history.back() : go('#'); };
  fill(meEl, S.user && chipEl ? chipEl : null, S.user ? h('button', { type: 'button', class: 'a-bar-btn e-appbar__me', title: S.user.email, 'aria-label': 'Account', onclick: account }, h('span', { class: 'a-avatar', 'aria-hidden': 'true' }, initials(S.user.name || S.user.email))) : null);
}

// ---------- sending status (live only): the outbox and the writes sent straight to the SDK (sync.js) ----------

const CHIP = { attention: 'Couldn’t send', 'at-risk': n => `${n} not sent yet`, offline: n => `${n} waiting: offline`, saving: 'Sending…', stale: 'Checking…', unknown: 'Connecting…', synced: 'Synced' };
let saving = null, chipEl = null;
function drawChip() {
  if (!saving || !chipEl) return;
  const { state, count } = saving.status();
  const t = CHIP[state];
  chipEl.textContent = typeof t === 'function' ? t(count) : t;
  chipEl.dataset.state = state;
}
if (!cloud.demo && cloud.enabled) {
  chipEl = h('span', { class: 'sl-sync', id: 'sync', role: 'status', 'aria-live': 'polite' });
  cloud.sending().then(sv => { saving = sv; sv?.onChange(() => { drawChip(); if (sv.canReload()) retryUpdate(); }); drawChip(); }, e => console.warn('Outbox unavailable', e));
}
// The update module reloads into a new version only when no one is typing, no sheet is open and nothing is sending.
let lastKey = 0;
addEventListener('input', () => { lastKey = Date.now(); }, true);
const typing = () => Date.now() - lastKey < 4000 || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
startUpdates({ canReload: () => !typing() && !document.querySelector('dialog[open]') && (!saving || saving.canReload()) });

// Sign-out refuses while something hasn't reached the server; the person can still choose to sign out and lose it.
async function signOutNow() {
  let r = await cloud.signOut();
  if (!r.ok && r.unsent) {
    if (!await confirmBox('Not sent yet', 'Some of your changes haven’t reached the server yet (no signal?). Stay signed in until the status at the top says Synced, or sign out and lose them.', 'Sign out anyway', true)) return;
    r = await cloud.signOut({ force: true });
  }
  if (!cloud.demo) location.reload();
}

function account() {
  const who = isGuest() ? ['Guest', 'Signed in with the guest passcode: you can send feedback, nothing else.']
    : codeRole() === 'setup' ? ['Set-up', 'Signed in with the set-up passcode: the round, its photos and questions.']
    : codeRole() === 'committee' ? ['Committee', 'Signed in with the committee passcode: you read the results.']
    : [S.user.name, S.user.email + (isAdmin() ? ' · admin' : S.roles.committee ? ' · selection committee' : '')];
  const m = modal('Account', [
    h('p', {}, who[0], h('br'), h('span', { class: 'e-small' }, who[1])),
    cloud.demo ? h('label', { class: 'e-label' }, 'Demo role', h('select', { class: 'e-select', onchange: e => { cloud.setDemoRole(e.target.value); location.reload(); } },
      Object.entries(cloud.DEMO_ROLES).map(([r, label]) => h('option', { value: r, selected: cloud.demoRole() === r }, label)))) : null,
    h('div', { class: 'e-actions' },
      round && canAnswer() ? h('button', { class: 'a-btn a-btn--tinted e-btn-quiet', type: 'button', onclick: async () => {
        if (!await confirmBox('Clear my answers?', 'This removes your scores and comments from this device. If you haven’t sent them, they’re gone.', 'Clear', true)) return;
        del(K.ans(round.cycle, S.user.email)); m.close(); loadMine().then(render);
      } }, 'Clear my answers') : null,
      h('button', { class: 'a-btn a-btn--tinted e-btn-quiet', type: 'button', onclick: () => m.close() }, 'Close'),
      h('button', { class: 'a-btn', type: 'button', onclick: async () => { m.close(); await signOutNow(); } }, 'Sign out')),
  ]);
}

// ---------- screens ----------

const first = name => String(name).split(/[\s,]+/)[0];
const faceOf = (a, cls = '') => (photos[a.id]
  ? h('img', { class: `sl-photo ${cls}`, src: photos[a.id], alt: '', width: 210, height: 270, loading: 'lazy' })
  : h('span', { class: `sl-photo sl-photo--none ${cls}`, 'aria-hidden': 'true' }, initials(a.name)));
const STATUS_TEXT = { done: 'Done', skipped: 'Skipped', partial: 'Started', todo: '' };

function homeScreen() {
  if (!round) {
    return empty(isStaff() ? 'No round yet' : 'No round open',
      isStaff() ? 'Set up the round: add the applicants, then publish it so everyone with the guest passcode can answer.' : 'There is no round open for you yet. If you were expecting one, ask the programme office.',
      isStaff() ? h('button', { class: 'a-btn', type: 'button', onclick: () => go('#setup') }, 'Set up the round') : null);
  }
  const p = progress(round, answers);
  const pct = Math.round((p.finished / p.total) * 100);
  const nxt = nextUnanswered(round, answers, -1);
  const go1 = () => go(nxt ? '#a/' + nxt.id : '#review');
  const open = isOpen();
  return h('div', { class: 'e-stack sl-col' },
    !open ? h('div', { class: 'e-warn-note' }, shutText()) : null,
    h('section', { class: 'e-card sl-intro' },
      h('h2', { class: 'e-h2', style: 'margin-top:0' }, round.title),
      h('p', {}, INTRO[1]),
      h('details', { class: 'sl-more' }, h('summary', {}, 'About this exercise'), INTRO.filter((_, i) => i !== 1).map(t => h('p', {}, t))),
      h('div', { class: 'sl-conf' }, h('span', { 'aria-hidden': 'true' }, '🔒'), h('span', {}, 'Confidential: only the selection committee sees who said what.')),
      h('div', { class: 'sl-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.total, 'aria-valuenow': p.finished, 'aria-label': 'Applicants answered' }, h('i', { style: `width:${pct}%` })),
      h('p', { class: 'e-small' }, `${p.finished} of ${p.total} answered${sent ? ' · sent' : ''}`),
      h('div', { class: 'e-actions' }, h('button', { class: 'a-btn e-go', type: 'button', onclick: go1 },
        p.finished === 0 && !sent ? 'Start' : nxt ? `Continue (${p.total - p.finished} left)` : sent ? 'Review what you sent' : 'Review and send'))),
    h('ul', { class: 'sl-grid', 'aria-label': 'Applicants' }, round.applicants.map(a => {
      const st = statusOf(round, answers[a.id]);
      return h('li', {}, h('button', { type: 'button', class: `sl-tile sl-tile--${st}`, onclick: () => go('#a/' + a.id), 'aria-label': `${a.name}${STATUS_TEXT[st] ? ', ' + STATUS_TEXT[st] : ''}` },
        faceOf(a), h('span', { class: 'sl-tile__name' }, a.name), STATUS_TEXT[st] ? h('span', { class: 'sl-tile__st' }, STATUS_TEXT[st]) : null));
    })));
}

function applicantScreen(id) {
  const idx = round.applicants.findIndex(a => a.id === id);
  const a = round.applicants[idx];
  const r = answers[id] || blank();
  answers[id] = r;
  header(a.name, { back: false });
  backEl.hidden = true;
  const saved = h('span', { class: 'sl-saved', 'aria-live': 'polite' });
  const save = () => { saveMine(); saved.textContent = 'Saved'; updateStatus(); };
  const prev = round.applicants[idx - 1], next = round.applicants[idx + 1];
  const goNext = () => go(next ? '#a/' + next.id : '#review');
  const p = progress(round, answers);
  const open = isOpen();

  const stat = h('span', { class: 'sl-apstat' });
  const updateStatus = () => { stat.textContent = STATUS_TEXT[statusOf(round, r)] || ''; };
  updateStatus();

  const naBtn = h('button', { type: 'button', class: 'sl-na', 'aria-pressed': String(!!r.na), disabled: !open, onclick: async () => {
    if (!r.na) {
      if (hasAnswer(round, r) && !await confirmBox('Skip ' + a.name + '?', 'This clears what you entered for them.', 'Skip them', true)) return;
      for (const q of round.questions) delete r[q.id];
      r.na = true; saveMine(); goNext();
    } else { r.na = false; saveMine(); render(); }
  } }, r.na ? 'Haven’t worked with them ✓ (tap to undo)' : 'I haven’t worked with them');

  const blocks = round.questions.map(q => {
    if (q.type === 'scale') {
      const name = 'q-' + q.id;
      return h('fieldset', { class: 'sl-q', disabled: !open },
        h('legend', { class: 'sl-q__label' }, q.label, q.required ? h('span', { class: 'sl-req' }, ' required') : null),
        h('div', { class: 'sl-scores' }, SCALE.map(v => h('label', {}, h('input', { type: 'radio', name, value: v, checked: r[q.id] === v, onchange: () => { r[q.id] = v; r.na = false; save(); } }), h('b', {}, String(v))))),
        q.low || q.high ? h('div', { class: 'sl-ends', 'aria-hidden': 'true' }, h('span', {}, '1 ' + (q.low || '')), h('span', {}, (q.high || '') + ' 5')) : null);
    }
    // One box for all of a person's comments (older answers with several lines still show, one per line).
    const ta = h('textarea', { class: 'e-textarea sl-ta', id: 'q-' + q.id, rows: 4, maxlength: 2000, disabled: !open, placeholder: q.hint || '', oninput: () => { debounceCommit(); sync(); } });
    ta.value = typeof r[q.id] === 'string' ? r[q.id] : '';
    const commit = () => {
      const v = ta.value.trim();
      if (v) { r[q.id] = v; r.na = false; } else delete r[q.id];
      save();
    };
    const debounceCommit = debounce(commit, 300);
    // Tap a suggestion to add it to the box (comma-separated); tap again to take it out. Still free text: they can edit after.
    const hasWord = (text, w) => new RegExp('(^|[^\\p{L}])' + w + '($|[^\\p{L}])', 'iu').test(text);
    const chips = SUGGESTED_COMMENTS.map(w => h('button', { type: 'button', class: 'sl-chip', disabled: !open, 'aria-pressed': 'false', onclick: () => {
      if (hasWord(ta.value, w)) ta.value = ta.value.replace(new RegExp('(^|(?<=[^\\p{L}]))' + w + '(?=$|[^\\p{L}])', 'iu'), '').replace(/\s*,(\s*,)+/g, ',').replace(/\s+,/g, ',').replace(/[ \t]{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '');
      else ta.value = ta.value.trim() ? ta.value.trim().replace(/[,.]$/, '') + ', ' + w : w;
      commit(); sync();
    } }, w));
    const sync = () => chips.forEach(b => b.setAttribute('aria-pressed', String(hasWord(ta.value, b.textContent))));
    sync();
    return h('div', { class: 'sl-q' }, h('label', { class: 'sl-q__label', for: 'q-' + q.id }, q.label, q.required ? h('span', { class: 'sl-req' }, ' required') : h('span', { class: 'sl-opt' }, ' optional')),
      ta, open ? h('div', { class: 'sl-chips', style: 'margin:8px 0 0', role: 'group', 'aria-label': 'Suggested comments, tap to add' }, chips) : null);
  });

  fill(app, h('div', { class: 'sl-col sl-apply' },
    h('div', { class: 'sl-toprow' },
      h('span', { class: 'sl-pos' }, `${idx + 1} of ${round.applicants.length} · ${p.total - p.finished} left`),
      h('button', { type: 'button', class: 'a-btn a-btn--plain a-btn--sm', onclick: () => go('#') }, 'All applicants')),
    h('div', { class: 'sl-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.total, 'aria-valuenow': p.finished, 'aria-label': 'Applicants answered' }, h('i', { style: `width:${Math.round((p.finished / p.total) * 100)}%` })),
    h('section', { class: 'e-card sl-card' },
      h('div', { class: 'sl-who-row' }, faceOf(a, 'sl-photo--lg'),
        h('div', { class: 'sl-who-text' }, h('h2', { class: 'sl-name' }, a.name), stat, naBtn)),
      r.na ? h('p', { class: 'e-small sl-skipped' }, 'Skipped: nothing more to answer for this applicant.') : h('div', { class: 'sl-qs' }, blocks)),
    h('div', { class: 'sl-fixed' }, h('div', { class: 'sl-fixed__in' },
      prev ? h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => go('#a/' + prev.id), 'aria-label': 'Previous applicant' }, '‹ Back') : null,
      h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => go('#') }, 'All'),
      saved,
      h('button', { class: 'a-btn e-go', type: 'button', onclick: goNext }, next ? 'Next ›' : 'Review')))));
  window.scrollTo(0, 0);
}

function reviewScreen() {
  header('Review and send', { back: true });
  const p = progress(round, answers);
  const w = warnings(round, answers);
  const open = isOpen();
  const nameIn = h('input', { class: 'e-input', id: 'sl-name', autocomplete: 'name', value: isGuest() ? '' : S.user.name || '', placeholder: isGuest() ? 'Optional: leave blank to stay anonymous' : '', maxlength: 120 });
  const status = h('p', { class: 'e-small', 'aria-live': 'polite' });
  const send = h('button', { class: 'a-btn e-go', type: 'button', disabled: !open }, sent ? 'Send again' : 'Send');
  send.onclick = async () => {
    const who = nameIn.value.trim() || (isGuest() ? 'Anonymous' : S.user.email);
    if (sent && !await confirmBox('Send again?', round.shared ? 'This replaces what you sent before.' : 'You already sent these. The committee will get a second copy.', 'Send again')) return;
    if (p.done + p.partial === 0 && !await confirmBox('Nothing to send', 'You haven’t answered about anyone. Send anyway?', 'Send anyway')) return;
    send.disabled = true; status.textContent = 'Sending…';
    try {
      const out = await deliver(who), via = out.via;
      sent = { at: Date.now(), via, ...(out.waiting ? { waiting: true } : {}) }; saveMine();
      if (via === 'device' || via === 'form') {
        const list = subs().filter(s => s.by !== S.user.email); list.push({ by: S.user.email, name: who, at: sent.at, answers });
        put(K.subs(round.cycle), list);
      }
      go('#done');
    } catch (e) { status.textContent = 'Couldn’t send: ' + errText(e) + ' Your answers are safe on this device; try again, or copy them under “Other ways”.'; send.disabled = false; }
  };
  const text = () => answersText(round, nameIn.value.trim() || (isGuest() ? 'Anonymous' : S.user.name), answers);
  fill(app, h('div', { class: 'sl-col sl-apply' },
    h('section', { class: 'e-card' },
      h('h2', { class: 'e-h2', style: 'margin-top:0' }, `${p.finished} of ${p.total} answered`),
      h('p', { class: 'e-small' }, `${p.done} with answers · ${p.skipped} skipped (haven’t worked with them)${p.partial ? ` · ${p.partial} started` : ''}${p.todo ? ` · ${p.todo} not answered` : ''}`),
      w.length ? h('div', { class: 'e-warn-note' }, h('p', { style: 'margin:0 0 6px;font-weight:600' }, 'Worth a look (you can still send):'),
        h('ul', { class: 'sl-comments' }, w.map(x => h('li', {}, h('a', { href: '#a/' + x.id }, x.name), ' ' + x.text)))) : h('p', { class: 'e-ok-note' }, 'Everyone is answered.')),
    h('section', { class: 'e-card' },
      h('label', { class: 'e-label', for: 'sl-name' }, 'Your name, as the committee will see it'),
      nameIn,
      !open ? h('p', { class: 'e-warn-note' }, shutText()) : null,
      h('p', { class: 'e-hint' }, round.shared ? 'Your answers go to the selection committee. Add your name only if you want them to know who said it.' : round.form ? 'Your answers go to the selection committee’s form. Nothing else is kept online.' : 'This round isn’t published, so “Send” keeps your answers on this device and shows them to the committee here.'),
      status,
      h('details', { class: 'sl-more' }, h('summary', {}, 'Other ways to keep your answers'),
        h('div', { class: 'e-actions' },
          h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text()); toast('Copied'); } catch { toast('Couldn’t copy. Use Download.'); } } }, 'Copy'),
          h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => download(`feedback-${round.cycle}.txt`, new Blob([text()], { type: 'text/plain' })) }, 'Download')))),
    h('div', { class: 'sl-fixed' }, h('div', { class: 'sl-fixed__in' },
      h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => { const x = nextUnanswered(round, answers, -1); go(x ? '#a/' + x.id : '#'); } }, w.length ? 'Fix' : 'All'),
      w.length ? h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => go('#') }, 'All') : null, send))));
  window.scrollTo(0, 0);
}

// Delivery: a published round goes to the shared store. A link round posts to the Google Form when it is wired to one (the reply
// can't be read from another site, so "sent" means the browser handed it over); otherwise it stays on this device.
async function deliver(who) {
  if (round.shared) {
    // Mirror on: the Google Form (source of truth) and the shared store (backup) both get it; one failing doesn't lose the answer.
    // (the store's 'waiting': kept in this device's outbox, it goes by itself once back online)
    if (round.mirror && canMirror(round) && !cloud.demo) {
      const [f, b] = await Promise.allSettled([postToForm(who), store.sendResponse(round, S.user, who, answers)]);
      if (f.status === 'rejected' && b.status === 'rejected') throw b.reason;
      return { via: f.status === 'rejected' ? 'store' : b.status === 'rejected' ? 'form' : 'both', waiting: f.status === 'rejected' && b.value === 'waiting' };
    }
    return { via: 'store', waiting: (await store.sendResponse(round, S.user, who, answers)) === 'waiting' };
  }
  if (cloud.demo || !round.form) return { via: 'device' };
  await postToForm(who);
  return { via: 'form' };
}
async function postToForm(who) {
  if (!navigator.onLine) throw new Error('No signal.');
  await fetch(formUrl(round), { method: 'POST', mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', body: formBody(round, who, answers) });
}

function doneScreen() {
  header('Thank you');
  fill(app, h('div', { class: 'e-stack sl-col' }, empty(sent?.waiting ? 'Saved. Thank you.' : 'Sent. Thank you.',
    sent?.waiting ? 'No signal just now: your feedback is kept on this device and goes to the selection committee by itself once you’re back online. Open the app again later; the status at the top says Synced once it has gone.'
    : sent?.via !== 'device' ? 'Your feedback went to the selection committee. You can come back and change it, then send again.' : 'Your feedback is saved on this device for the committee.',
    h('div', { class: 'e-actions' }, h('button', { class: 'a-btn', type: 'button', onclick: () => go('#') }, 'Back to the list')))));
}

// ---------- admins and PDs ----------

function setupScreen() {
  header('Set up the round');
  const titleIn = h('input', { class: 'e-input', id: 'su-title', value: round?.title || 'Applicant feedback', maxlength: 200 });
  const cycleIn = h('input', { class: 'e-input', id: 'su-cycle', value: round?.cycle === 'round' || !round ? '' : round.cycle, maxlength: 20, placeholder: 'e.g. 2027', disabled: !!round?.shared });
  const names = h('textarea', { class: 'e-textarea', id: 'su-names', rows: 8, placeholder: 'One name per line, in the order they should appear' });
  names.value = round ? round.applicants.map(a => a.name).join('\n') : '';
  const opensIn = h('input', { class: 'e-input', id: 'su-opens', type: 'datetime-local', value: toLocalInput(round?.opensAt) });
  const closesIn = h('input', { class: 'e-input', id: 'su-closes', type: 'datetime-local', value: toLocalInput(round?.closesAt) });
  const wired = round?.shared ? `Published (${round.status}): everyone with the guest passcode sees it as soon as they open the app.` : round?.form ? 'Connected to a Google Form.' : 'Not published: answers stay on each person’s device, or go to the Google Form if the round is connected to one.';
  const out = h('div', {});
  let qs = cleanQuestions(round?.questions).map(q => ({ ...q }));   // the questions as edited on this screen
  let mirror = !!round?.mirror;
  const build = () => {
    const apps = parseNames(names.value);
    if (!apps.length) { toast('Add at least one name.'); return null; }
    // keep ids, photos and any form wiring for names that were already there
    const old = new Map((round?.applicants || []).map(a => [a.name.toLowerCase(), a]));
    const merged = apps.map(a => old.get(a.name.toLowerCase()) || a);
    const used = new Set(); merged.forEach((a, i) => { if (used.has(a.id)) a.id = 'n' + (i + 1); used.add(a.id); });
    const next = cleanRound({ title: titleIn.value, cycle: cycleIn.value || 'round', applicants: merged, questions: qs, form: round?.form, mirror });
    if (!next) { toast('That round isn’t valid.'); return null; }
    next.opensAt = fromLocalInput(opensIn.value); next.closesAt = fromLocalInput(closesIn.value);
    if (next.opensAt != null && next.closesAt != null && next.closesAt <= next.opensAt) { toast('The round must close after it opens.'); return null; }
    return next;
  };
  const save = () => { const next = build(); if (!next) return null; put(K.round, next); round = next; loadMine(); return next; };
  // the shared store: everyone who may answer sees the round; close it to stop answers
  const publish = async status => {
    const next = build(); if (!next) return;
    if (next.cycle === 'round') { toast('Give the round an intake (for example 2027) first.'); return; }
    if (!round?.shared && !await confirmBox('Publish the round?', 'The applicants’ names go to the shared store, and everyone with the guest passcode can see them and answer.', 'Publish')) return;
    try { round = await store.saveRound(next, status); await loadMine(); toast(status === 'open' ? 'Saved and published' : 'Closed'); render(); } catch (e) { toast('Couldn’t save. ' + errText(e)); }
  };
  const link = () => {
    const r = round?.shared ? build() : save(); if (!r) return;
    const url = `${location.origin}${location.pathname}#r=${encodeRound(r)}`;
    fill(out, h('p', { class: 'e-small' }, 'Only for a round that isn’t published. Send this link privately (WhatsApp or email). It carries the applicants’ names, so don’t post it anywhere public:'),
      h('textarea', { class: 'e-textarea sl-code', readonly: true, 'aria-label': 'Private link', onfocus: e => e.target.select() }, url),
      h('div', { class: 'e-actions' }, h('button', { class: 'a-btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast('Select the link and copy it.'); } } }, 'Copy link')));
  };
  const imp = h('textarea', { class: 'e-textarea sl-code', id: 'su-import', 'aria-label': 'Round link or JSON', placeholder: 'Paste a round link or round JSON' });

  // the questions
  const qBox = h('div', { class: 'sl-qedit' });
  const drawQs = () => {
    fill(qBox, qs.map((q, i) => h('div', { class: 'sl-qrow' },
      h('input', { class: 'e-input', 'aria-label': `Question ${i + 1} text`, value: q.label, maxlength: 200, oninput: e => { q.label = e.target.value; } }),
      h('div', { class: 'sl-qrow__line' },
        h('select', { class: 'e-select', 'aria-label': `Question ${i + 1} type`, onchange: e => { q.type = e.target.value; drawQs(); } },
          h('option', { value: 'scale', selected: q.type === 'scale' }, 'Score 1 to 5'), h('option', { value: 'text', selected: q.type === 'text' }, 'Text box')),
        h('label', { class: 'sl-chk' }, h('input', { type: 'checkbox', checked: !!q.required, onchange: e => { q.required = e.target.checked; } }), ' Required')),
      q.type === 'scale'
        ? h('div', { class: 'sl-qrow__line' },
          h('input', { class: 'e-input', 'aria-label': `Question ${i + 1}: words for 1`, placeholder: 'Words for 1 (e.g. Unsuitable)', value: q.low || '', maxlength: 30, oninput: e => { q.low = e.target.value; } }),
          h('input', { class: 'e-input', 'aria-label': `Question ${i + 1}: words for 5`, placeholder: 'Words for 5 (e.g. Best fit)', value: q.high || '', maxlength: 30, oninput: e => { q.high = e.target.value; } }))
        : h('input', { class: 'e-input', 'aria-label': `Question ${i + 1}: hint shown in the box`, placeholder: 'Hint shown in the box', value: q.hint || '', maxlength: 200, oninput: e => { q.hint = e.target.value; } }),
      h('div', { class: 'sl-qrow__line sl-qrow__btns' },
        h('button', { type: 'button', class: 'a-btn a-btn--tinted a-btn--sm', disabled: i === 0, 'aria-label': `Move question ${i + 1} up`, onclick: () => { [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; drawQs(); } }, 'Up'),
        h('button', { type: 'button', class: 'a-btn a-btn--tinted a-btn--sm', disabled: i === qs.length - 1, 'aria-label': `Move question ${i + 1} down`, onclick: () => { [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; drawQs(); } }, 'Down'),
        h('button', { type: 'button', class: 'a-btn a-btn--tinted a-btn--sm', disabled: qs.length === 1, 'aria-label': `Remove question ${i + 1}`, onclick: () => { qs.splice(i, 1); drawQs(); } }, 'Remove')))));
  };
  drawQs();

  // the photos (published rounds)
  const photoBox = h('div', {});
  const drawPhotos = () => {
    if (!round?.shared) { fill(photoBox, h('p', { class: 'e-small' }, 'Publish the round first: photos are kept with the published round, where residents and faculty can see them next to each name.')); return; }
    const pick = h('input', { type: 'file', accept: 'image/*', class: 'sl-file', id: 'ph-one', 'aria-label': 'Choose a photo' });
    let target = null;
    pick.addEventListener('change', async () => { if (pick.files[0] && target) await addPhotos([[target, pick.files[0]]]); pick.value = ''; });
    const many = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sl-file', id: 'ph-many', 'aria-label': 'Choose photos named after the applicants' });
    many.addEventListener('change', async () => {
      const pairs = [], miss = [];
      for (const f of many.files) { const a = matchPhotoFile(round, f.name); if (a) pairs.push([a, f]); else miss.push(f.name); }
      many.value = '';
      await addPhotos(pairs, miss);
    });
    fill(photoBox,
      h('p', { class: 'e-small' }, 'Passport-style: the app crops each picture to a small 7:9 portrait, so any photo works. Photos are shown to everyone who answers.'),
      h('div', { class: 'e-actions' }, h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => many.click() }, 'Add many (file name = applicant name)'), many),
      h('div', { class: 'e-list' }, round.applicants.map(a => h('div', { class: 'e-row e-row--static' },
        faceOf(a, 'sl-photo--sm'),
        h('span', { class: 'e-row__body' }, h('span', { class: 'e-row__title' }, a.name)),
        h('button', { type: 'button', class: 'a-btn a-btn--tinted a-btn--sm', 'aria-label': `${photos[a.id] ? 'Change' : 'Add'} photo for ${a.name}`, onclick: () => { target = a; pick.click(); } }, photos[a.id] ? 'Change' : 'Add photo'),
        photos[a.id] ? h('button', { type: 'button', class: 'a-btn a-btn--tinted a-btn--sm', 'aria-label': `Remove photo of ${a.name}`, onclick: async () => {
          try { await store.removePhoto(round.cycle, a.id); delete photos[a.id]; drawPhotos(); } catch (e) { toast('Couldn’t remove. ' + errText(e)); }
        } }, 'Remove') : null))),
      pick);
  };
  async function addPhotos(pairs, missed = []) {
    let ok = 0; const bad = [...missed];
    for (const [a, f] of pairs) {
      try { const b64 = await passportJpeg(f); await store.savePhoto(round.cycle, a.id, b64); photos[a.id] = photoSrc(b64); ok++; }
      catch (e) { bad.push(f.name + ' (' + errText(e) + ')'); }
    }
    drawPhotos();
    toast(`${ok} photo${ok === 1 ? '' : 's'} added${bad.length ? '. Not used: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? '…' : '') : ''}`);
  }
  drawPhotos();

  const mirrorBox = round?.form ? h('div', {},
    h('label', { class: 'sl-chk', style: 'display:flex;gap:8px;margin-top:12px' },
      h('input', { type: 'checkbox', id: 'su-mirror', checked: mirror, onchange: e => { mirror = e.target.checked; } }), ' Also send every answer to the Google Form'),
    h('p', { class: 'e-hint', style: 'margin-top:4px' }, 'The Form stays the source of truth; the app keeps its own copy as a backup. Works only with the standard two questions. Someone who sends again adds another row in the Form (the app keeps just their latest). Save changes to apply.')) : null;
  // The page opens locked: every field and button is disabled until "Unlock to edit", so a stray tap or keystroke changes nothing.
  // Any save redraws the page, which locks it again. The passcodes card keeps Show working while locked (viewing changes nothing).
  const lockBar = h('div', { class: 'sl-lockbar', role: 'group', 'aria-label': 'Editing lock' });
  const locks = [];
  let idle = null;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => setLocked(true), 5 * 60e3); };   // locks again after 5 minutes without use
  const setLocked = locked => {
    clearTimeout(idle); if (!locked) arm();
    locks.forEach(f => { f.disabled = locked; });
    fill(lockBar,
      h('span', { class: 'sl-lockbar__msg' }, h('span', { 'aria-hidden': 'true' }, locked ? '🔒 ' : '🔓 '), locked ? 'Locked: nothing here can change by accident.' : 'Unlocked. It locks again after 5 minutes without use, or when the round is saved.'),
      h('button', { class: locked ? 'a-btn' : 'a-btn a-btn--tinted', type: 'button', id: 'su-lock', onclick: () => setLocked(!locked) }, locked ? 'Unlock to edit' : 'Lock'));
  };
  const lockable = (...kids) => { const f = h('fieldset', { class: 'e-fieldset sl-lock', disabled: true }, ...kids); locks.push(f); return f; };
  const body = lockable(h('div', { class: 'e-stack' },
    h('section', { class: 'e-card' },
      h('h2', { class: 'e-h2', style: 'margin-top:0' }, 'The round'),
      h('label', { class: 'e-label', for: 'su-title' }, 'Title'), titleIn,
      h('label', { class: 'e-label', for: 'su-cycle', style: 'margin-top:12px;display:block' }, 'Intake'), cycleIn,
      h('label', { class: 'e-label', for: 'su-names', style: 'margin-top:12px;display:block' }, 'Applicants'), names,
      h('label', { class: 'e-label', for: 'su-opens', style: 'margin-top:12px;display:block' }, 'Opens (optional)'), opensIn,
      h('label', { class: 'e-label', for: 'su-closes', style: 'margin-top:12px;display:block' }, 'Closes (optional)'), closesIn,
      h('p', { class: 'e-hint' }, 'Answers are taken only between these times (published rounds; blank means no limit). Close the round by hand to stop answers at once.'),
      h('p', { class: 'e-hint' }, wired + ' Names are never in the app’s code. Don’t rename people once answers are coming in: a changed name counts as a new applicant.'),
      h('h3', { class: 'e-h3', style: 'margin:16px 0 4px' }, 'Questions asked about each applicant'),
      h('p', { class: 'e-hint', style: 'margin-top:0' }, 'Up to ' + MAX_QUESTIONS + '. Changing the wording is safe any time; removing a question hides its earlier answers.'),
      qBox, mirrorBox,
      h('div', { class: 'e-actions' },
        h('button', { class: 'a-btn a-btn--tinted a-btn--sm', type: 'button', disabled: qs.length >= MAX_QUESTIONS, onclick: () => { qs.push({ id: 'q' + (Date.now() % 100000), type: 'text', label: 'New question', required: false }); drawQs(); } }, 'Add a question'),
        h('button', { class: 'a-btn a-btn--tinted a-btn--sm', type: 'button', onclick: () => { qs = DEFAULT_QUESTIONS.map(q => ({ ...q })); drawQs(); } }, 'Back to the standard two')),
      h('div', { class: 'e-actions' },
        round?.shared
          ? [h('button', { class: 'a-btn', type: 'button', onclick: () => publish(round.status) }, 'Save changes'),
            h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => publish(round.status === 'open' ? 'closed' : 'open') }, round.status === 'open' ? 'Close the round' : 'Reopen the round')]
          : [h('button', { class: 'a-btn', type: 'button', onclick: () => publish('open') }, 'Publish to everyone'),
            h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => { if (save()) toast('Saved on this device'); } }, 'Save on this device only')],
        h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: link }, 'Make a private link')), out),
    h('section', { class: 'e-card' }, h('h2', { class: 'e-h2', style: 'margin-top:0' }, 'Photos'), photoBox),
    isAdmin() ? committeeCard() : null,
    isAdmin() && round?.shared ? retentionCard() : null,
    h('section', { class: 'e-card' },
      h('h2', { class: 'e-h2', style: 'margin-top:0' }, 'Already have a round?'),
      h('p', { class: 'e-small' }, 'Paste a link or the round file (it may also connect the round to the committee’s Google Form).'),
      imp,
      h('div', { class: 'e-actions' }, h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => {
        const r = readRoundText(imp.value);
        if (!r) { toast('That didn’t look like a round.'); return; }
        put(K.round, r); round = r; photos = {}; loadMine().then(() => { toast('Round loaded'); render(); });
      } }, 'Load it'))),
    round && !round.shared ? h('section', { class: 'e-card' },
      h('button', { class: 'a-btn a-btn--danger a-btn--tinted', type: 'button', onclick: async () => {
        if (!await confirmBox('Remove the round?', 'This removes the round and the answers kept on this device. The Google Form’s responses aren’t touched.', 'Remove', true)) return;
        [K.round, K.ans(round.cycle, S.user.email), K.subs(round.cycle)].forEach(del); round = null; answers = {}; sent = null; go('#');
      } }, 'Remove the round from this device')) : null));
  const page = h('div', { class: 'e-stack sl-col' }, lockBar, body, isAdmin() ? passcodeCard(lockable) : null);
  for (const ev of ['input', 'click']) page.addEventListener(ev, () => { if (!locks[0].disabled) arm(); });
  fill(app, page);
  setLocked(true);
}

// The retention delete (admins): every response and photo of the round goes once the selection is over. The round stays
// (closed) with its title and applicants. Typing the intake confirms it, so a stray tap can't do it.
function retentionCard() {
  const typed = h('input', { class: 'e-input', id: 'rt-confirm', autocomplete: 'off', 'aria-label': 'Type the intake to confirm' });
  const btn = h('button', { class: 'a-btn a-btn--danger', type: 'button', onclick: async () => {
    if (typed.value.trim() !== round.cycle) { toast(`Type ${round.cycle} to confirm.`); return; }
    if (!await confirmBox(`Delete every answer and photo of ${round.cycle}?`, 'This can’t be undone. Download the results first if they are needed.', 'Delete', true)) return;
    btn.disabled = true;
    try {
      if (round.status === 'open') round = await store.saveRound(round, 'closed');
      const n = await store.deleteRoundData(round.cycle);
      photos = {};
      toast(`Deleted ${n.responses} ${n.responses === 1 ? 'response' : 'responses'} and ${n.photos} ${n.photos === 1 ? 'photo' : 'photos'}.`);
      render();
    } catch (e) { toast('Couldn’t delete. ' + errText(e)); btn.disabled = false; }
  } }, 'Delete answers and photos');
  return h('section', { class: 'e-card' },
    h('h2', { class: 'e-h2', style: 'margin-top:0' }, 'After the selection'),
    h('p', { class: 'e-small' }, 'Feedback on applicants is kept only as long as the selection needs it. When it is over, delete this round’s answers and photos (the round is closed first). Download the results first if the committee needs a copy.'),
    h('label', { class: 'e-label', for: 'rt-confirm' }, `Type ${round.cycle} to confirm`), typed,
    h('div', { class: 'e-actions' }, btn));
}

// who reads the results with a Google sign-in (besides the committee passcode): kept by admins
function committeeCard() {
  const box = h('div', {});
  const email = h('input', { class: 'e-input', id: 'cm-email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com', 'aria-label': 'Committee member’s email' });
  const name = h('input', { class: 'e-input', id: 'cm-name', autocomplete: 'off', placeholder: 'Name', 'aria-label': 'Committee member’s name' });
  const draw = async () => {
    let list = [];
    try { list = await store.listCommittee(); } catch (e) { fill(box, h('p', { class: 'e-alert' }, 'Couldn’t load the committee. ' + errText(e))); return; }
    fill(box, list.length ? h('div', { class: 'e-list' }, list.map(m => h('div', { class: 'e-row e-row--static' },
      h('span', { class: 'e-row__body' }, h('span', { class: 'e-row__title' }, m.name || m.email), m.name ? h('span', { class: 'e-row__meta' }, m.email) : null),
      h('button', { class: 'a-btn a-btn--tinted a-btn--sm', type: 'button', 'aria-label': 'Remove ' + (m.name || m.email), onclick: async () => {
        try { await store.removeCommittee(m.email); draw(); } catch (e) { toast('Couldn’t remove. ' + errText(e)); }
      } }, 'Remove')))) : h('p', { class: 'e-small' }, 'No one yet. The committee passcode also opens the results.'));
  };
  draw();
  return h('section', { class: 'e-card' },
    h('h2', { class: 'e-h2', style: 'margin-top:0' }, 'Selection committee'),
    h('p', { class: 'e-small' }, 'They read every response, with names, signing in with Google. Use the email they sign in with.'),
    box,
    h('div', { class: 'e-stack', style: 'margin-top:12px' }, email, name),
    h('div', { class: 'e-actions' }, h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: async () => {
      try { await store.saveCommittee({ email: email.value, name: name.value }); email.value = ''; name.value = ''; draw(); } catch (e) { toast(errText(e)); }
    } }, 'Add')));
}

// the three sign-in passcodes (admins): a guest sends feedback, Set up opens this page, Committee reads the Results.
// A passcode set here replaces the Worker secret of the same role; a role with none set here still uses its secret (not shown).
function passcodeCard(lockable) {
  let codes = {}, shown = false, editing = null, loaded = false, failed = '';
  const box = h('div', {});
  const draw = () => {
    if (failed) { fill(box, h('p', { class: 'e-alert' }, failed)); return; }
    if (!loaded) { fill(box, h('p', { class: 'e-loading' }, 'Loading…')); return; }
    fill(box, CODE_ROLES.map(r => {
      const code = codes[r.id];
      const others = Object.fromEntries(Object.entries(codes).filter(([k]) => k !== r.id));
      const head = h('div', { class: 'sl-code-head' }, h('strong', {}, r.label + ' passcode'), h('span', { class: 'e-small' }, r.what));
      if (editing === r.id) {
        const input = h('input', { class: 'e-input sl-codein', id: 'pc-' + r.id, autocomplete: 'off', spellcheck: 'false', value: newPasscode(), maxlength: 100, 'aria-label': `New ${r.label.toLowerCase()} passcode` });
        return h('form', { class: 'sl-codebox', onsubmit: async ev => {
          ev.preventDefault();
          const next = input.value.trim(), bad = codeProblem(r.id, next, others);
          if (bad) { toast(bad); return; }
          if (!await confirmBox(`Change the ${r.label.toLowerCase()} passcode?`, 'The old one stops working for new sign-ins at once. People already signed in stay in until they sign out.', 'Change')) return;
          try { await store.saveCode(r.id, next); codes[r.id] = next; editing = null; shown = true; draw(); toast(`${r.label} passcode changed`); } catch (e) { toast('Couldn’t change it. ' + errText(e)); }
        } }, head,
          h('label', { class: 'e-label', for: input.id }, 'New passcode (change it if you like; capitals don’t matter)'), input,
          h('div', { class: 'e-actions' },
            h('button', { class: 'a-btn', type: 'submit' }, 'Save'),
            h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => { input.value = newPasscode(); input.focus(); } }, 'Suggest another'),
            h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: () => { editing = null; draw(); } }, 'Cancel')));
      }
      return h('div', { class: 'sl-codebox' }, head,
        code
          ? h('div', { class: 'sl-codeline' }, h('code', { class: 'sl-codeval', 'data-role': r.id }, shown ? code : '•'.repeat(Math.min(code.length, 14))),
            h('button', { class: 'a-btn a-btn--tinted a-btn--sm', type: 'button', 'aria-label': `Copy the ${r.label.toLowerCase()} passcode`, onclick: async () => { try { await navigator.clipboard.writeText(code); toast('Copied'); } catch { toast('Show it, then select and copy.'); } } }, 'Copy'))
          : h('p', { class: 'e-small', style: 'margin:4px 0' }, 'Not set here yet: the one saved in Cloudflare is in use, and can’t be shown. Set a new one to take over.'),
        h('div', { class: 'e-actions' }, h('button', { class: 'a-btn a-btn--tinted a-btn--sm', type: 'button', id: 'pc-change-' + r.id, onclick: () => { editing = r.id; draw(); } }, code ? 'Change' : 'Set a passcode here')));
    }));
  };
  store.listCodes().then(c => { codes = c; loaded = true; draw(); }, e => { failed = 'Couldn’t load the passcodes. ' + errText(e); draw(); });
  draw();
  const showBtn = h('button', { class: 'a-btn a-btn--tinted a-btn--sm', type: 'button', id: 'pc-show', 'aria-pressed': 'false', onclick: () => { shown = !shown; showBtn.textContent = shown ? 'Hide' : 'Show'; showBtn.setAttribute('aria-pressed', String(shown)); draw(); } }, 'Show');
  return h('section', { class: 'e-card' },
    h('div', { class: 'sl-code-head sl-code-head--row' }, h('h2', { class: 'e-h2', style: 'margin:0' }, 'Sign-in passcodes'), showBtn),
    h('p', { class: 'e-small' }, 'Everyone but the admins signs in with one of these. Anyone holding a passcode has that role, so share them like keys. Only admins see and change them.'),
    lockable(box));
}

async function resultsScreen() {
  header('Results');
  if (!round) { fill(app, empty('No round', '', null)); return; }
  const n = seq;
  let list;
  if (round.shared) {
    fill(app, h('p', { class: 'e-loading' }, 'Loading…'));
    try { list = (await store.listResponses(round.cycle)).map(r => ({ by: r.email, name: r.name, at: r.updatedAt, answers: cleanAnswers(round, r.answers) })); }
    catch (e) { fill(app, h('p', { class: 'e-alert' }, 'Couldn’t load the responses. ' + errText(e))); return; }
    if (n !== seq) return;
  } else list = subs();
  const sum = summary(round, list);
  const sq = scaleQuestions(round);
  const staffBar = tabs('results');
  const many = round.questions.filter(q => q.type === 'text').length > 1;
  const ap = id => round.applicants.find(a => a.id === id);
  fill(app, h('div', { class: 'e-stack e-wide' },
    staffBar,
    h('div', { class: 'e-note' }, round.shared
      ? `${round.title} (${round.status}): ${list.length} ${list.length === 1 ? 'response' : 'responses'}. Only the committee and admins see this screen.`
      : `${list.length} ${list.length === 1 ? 'response was' : 'responses were'} sent from this device. Answers sent to the Google Form are in its response sheet; publish the round to see everyone’s here.`),
    h('p', { class: 'e-small' }, 'Tap a name to read their comments.'),
    h('div', { class: 'e-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Scores by applicant' }, h('table', { class: 'e-table' },
      h('thead', {}, h('tr', {}, [h('th', { scope: 'col' }, 'Applicant'), ...sq.map(q => h('th', { scope: 'col' }, sq.length === 1 ? 'Mean (n)' : q.label + ' (mean, n)')), h('th', { scope: 'col' }, 'Answered'), h('th', { scope: 'col' }, 'Skipped')])),
      sum.map(s => {
        const box = h('td', { colspan: String(sq.length + 3) }, s.comments.length
          ? h('ul', { class: 'sl-comments' }, s.comments.map(c => h('li', {}, many ? h('em', {}, c.q + ': ') : null, c.text, ' ', h('span', { class: 'sl-who' }, '· ' + c.by))))
          : h('p', { class: 'e-small', style: 'margin:0' }, 'No comments yet.'));
        const row = h('tr', {}, box); row.hidden = true;
        const btn = h('button', { type: 'button', class: 'sl-namebtn', 'aria-expanded': 'false', onclick: () => {
          const open = row.hidden; row.hidden = !open; btn.setAttribute('aria-expanded', String(open));
        } }, faceOf(ap(s.id), 'sl-photo--sm'), h('span', {}, s.name), h('span', { class: 'sl-cnt' }, s.comments.length ? s.comments.length + (s.comments.length === 1 ? ' comment ▾' : ' comments ▾') : ''));
        return h('tbody', {}, h('tr', {}, h('th', { scope: 'row' }, btn),
          ...s.scales.map(sc => h('td', { class: 'sl-mean' }, sc.mean == null ? '–' : sc.mean.toFixed(1) + ' (' + sc.n + ')')),
          h('td', {}, String(s.answered)), h('td', {}, String(s.skipped))), row);
      }))),
    list.length ? h('section', { class: 'e-card' }, h('h2', { class: 'e-h3', style: 'margin-top:0' }, 'Who has answered'),
      h('p', { class: 'e-small' }, list.map(s => s.name).sort((a, b) => a.localeCompare(b)).join(', '))) : null,
    h('div', { class: 'e-actions' }, h('button', { class: 'a-btn', type: 'button', disabled: !list.length, onclick: () => download(`results-${round.cycle}.csv`, new Blob([resultsCSV(round, list)], { type: 'text/csv' })) }, 'Download CSV'))));
  window.aRefreshBar?.();
}

// ---------- render and boot ----------

let seq = 0;
const tabs = cur => (isStaff() || canResults())
  ? segment([['home', 'Feedback', canAnswer()], ['results', 'Results', canResults()], ['setup', 'Set up', isStaff()]].filter(t => t[2]).map(([id, label]) => ({ id, label })), cur, id => go(id === 'home' ? '#' : '#' + id)) : null;
async function render() {
  const n = ++seq;
  if (!S.user) return;
  if (!mayIn()) {
    header('NUHS Residency Applications');
    fill(app, empty('Not an admin account', `${S.user.email} isn’t an admin or on the selection committee. Everyone else signs in with the passcode they were given.`,
      h('button', { class: 'a-btn', type: 'button', onclick: () => signOutNow() }, 'Sign out')));
    return;
  }
  if (n !== seq) return;
  const r = route();
  const staffBar = ['home', 'setup'].includes(r.name) ? tabs(r.name) : null;   // Results draws its own, after it has loaded
  if (r.name === 'a') return applicantScreen(r.id);
  if (r.name === 'review' && round) return reviewScreen();
  if (r.name === 'done') return doneScreen();
  header(r.name === 'setup' ? 'Set up the round' : r.name === 'results' ? 'Results' : round ? round.title : 'NUHS Residency Applications');
  backEl.hidden = true;
  const body = r.name === 'setup' ? (setupScreen(), null) : r.name === 'results' ? (resultsScreen(), null) : homeScreen();
  if (body) fill(app, h('div', { class: 'e-stack sl-col' }, staffBar, body));
  else if (staffBar) { backEl.hidden = true; app.prepend(h('div', { class: 'sl-col' }, staffBar)); }
  window.aRefreshBar?.();
}
window.addEventListener('hashchange', () => render());

// Everyone signs in with a passcode; the Worker (worker/guest.js) checks it and hands back a sign-in for that role (rules:
// isGuest, isSetupCode, isCommitteeCode). Admins use Google, below.
function signInScreen() {
  header('NUHS Residency Applications');
  const code = h('input', { class: 'e-input', id: 'gp', type: 'password', autocomplete: 'off', 'aria-label': 'Passcode', placeholder: 'Passcode' });
  const go2 = h('button', { class: 'a-btn', type: 'submit' }, 'Continue');
  fill(app, h('section', { class: 'e-card', style: 'max-width:520px;margin:0 auto' },
    h('h2', { class: 'e-h2', style: 'margin-top:0' }, 'NUHS Residency Applications'),
    h('p', {}, 'Confidential feedback on residency applicants. Sign in with the passcode you were given; your name is optional.'),
    h('form', { onsubmit: async e => {
      e.preventDefault(); if (!code.value.trim()) return; go2.disabled = true;
      try { await cloud.signInWithPasscode(code.value.trim()); } catch (err) { toast(errText(err)); go2.disabled = false; }
    } }, code, h('div', { class: 'e-actions' }, go2)),
    h('details', { class: 'sl-more', style: 'margin-top:16px' }, h('summary', {}, 'Admin sign-in'),
      h('p', { class: 'e-small' }, 'For the app’s admins and the selection committee: sign in with your Google account.'),
      h('button', { class: 'a-btn a-btn--tinted', type: 'button', onclick: async () => { try { await cloud.signInAdmin(); } catch (e) { toast('Sign-in failed. ' + errText(e)); } } }, 'Sign in with Google')),
    cloud.demo ? h('p', { class: 'e-small' }, 'Demo: made-up applicants, kept only in this browser. Any passcode works.') : null));
}

cloud.watchUser(async u => {
  S.user = u;
  if (!u) { S.roles = { admin: false, committee: false }; signInScreen(); return; }
  try { S.roles = await cloud.getRoles(u); } catch (e) { S.roles = { admin: false, committee: false }; toast('Couldn’t check your access. ' + errText(e)); }
  await loadRound(); await loadMine();
  render();
});
if (!cloud.enabled) fill(app, h('p', { class: 'e-alert' }, 'Sign-in isn’t set up yet. Try the demo: add ?demo to the address.'));
