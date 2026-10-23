// Unit tests for applicants/js/model.js. Run: node applicants/test/model.test.mjs
import assert from 'node:assert/strict';
import {
  parseNames, cleanRound, cleanQuestions, encodeRound, decodeRound, readRoundText, cleanAnswers, statusOf, progress, nextUnanswered, warnings, formBody, formUrl, canMirror,
  summary, resultsCSV, answersText, demoRound, demoPhoto, blank, photoSrc, matchPhotoFile, scaleQuestions, DEFAULT_QUESTIONS, MAX_QUESTIONS, newPasscode, codeProblem, CODE_ROLES,
  roundState, toLocalInput, fromLocalInput,
} from '../applicants/js/model.js';

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('names: bullets, numbers, blanks and repeats', () => {
  const a = parseNames('1. Zoë Tan\n- Lee Wei\n\n  lee   wei \nMark, Jr');
  assert.deepEqual(a.map(x => x.name), ['Zoë Tan', 'Lee Wei', 'Mark, Jr']);
  assert.deepEqual(a.map(x => x.id), ['a1', 'a2', 'a3']);
  assert.equal(parseNames('').length, 0);
});

t('questions: defaults, limits, ids, types', () => {
  assert.deepEqual(cleanQuestions(undefined).map(q => q.id), ['score', 'comment']);
  assert.equal(cleanQuestions([]).length, 2);
  const q = cleanQuestions([
    { id: 'Score!', type: 'scale', label: ' Overall ', low: 'Bad', high: 'Good', required: true },
    { id: 'score', type: 'text', label: 'dup id' },
    { id: 'na', type: 'text', label: 'reserved id' },
    { type: 'weird', label: 'unknown type is a text box', hint: 'h' },
    { label: '' },
  ]);
  assert.deepEqual(q.map(x => x.type), ['scale', 'text', 'text', 'text']);
  assert.equal(new Set(q.map(x => x.id)).size, 4);
  assert.ok(!q.some(x => x.id === 'na'));
  assert.equal(q[0].label, 'Overall'); assert.equal(q[0].low, 'Bad'); assert.equal(q[0].required, true);
  assert.equal(cleanQuestions(Array.from({ length: 20 }, (_, i) => ({ type: 'text', label: 'Q' + i }))).length, MAX_QUESTIONS);
  assert.equal(cleanQuestions([{ type: 'text', label: 'x'.repeat(500) }])[0].label.length, 200);
});

const round = cleanRound({ title: 'T', cycle: '2027', applicants: parseNames('Zoë Tan\nLee Wei') });
t('round survives a link, including non-ASCII names and questions', () => {
  const custom = cleanRound({ title: 'T', cycle: '2027', applicants: parseNames('Zoë Tan\nLee Wei'), questions: [{ id: 'teamwork', type: 'scale', label: 'Teamwork', low: 'Poor', high: 'Great' }, { id: 'notes', type: 'text', label: 'Notes' }] });
  assert.deepEqual(decodeRound(encodeRound(custom)), custom);
  assert.deepEqual(decodeRound(encodeRound(round)), round);
  assert.deepEqual(readRoundText('https://x/applicants/#r=' + encodeRound(round)), round);
  assert.deepEqual(readRoundText(JSON.stringify(round)), round);
  assert.equal(decodeRound('nonsense!!'), null);
  assert.equal(readRoundText('{bad'), null);
  assert.deepEqual(round.questions.map(q => q.id), ['score', 'comment']);   // a first-version round gets the standard two
});
t('cleanRound rejects empty and half-wired forms', () => {
  assert.equal(cleanRound({ applicants: [] }), null);
  assert.equal(cleanRound(null), null);
  const half = cleanRound({ applicants: [{ id: 'a1', name: 'X' }], form: { id: 'a'.repeat(30), nameEntry: 5 } });
  assert.equal(half.form, undefined);   // an applicant without field ids: no form
  const full = cleanRound({ applicants: [{ id: 'a1', name: 'X', entry: { score: 1, comment: 2 } }], form: { id: 'a'.repeat(30), nameEntry: 5 } });
  assert.deepEqual(full.form, { id: 'a'.repeat(30), nameEntry: 5 });
  assert.equal(cleanRound({ applicants: [{ name: '<b>x' }, { name: '' }, { id: 'a1', name: 'dup' }, { id: 'q', name: 'ok' }] }).applicants.length, 2);
});

t('answers: status, required, skipped and progress', () => {
  const ans = cleanAnswers(round, { a1: { score: 4, comment: 'Calm in a crisis' }, a2: { score: 9, comment: ' ', na: true } });
  assert.equal(statusOf(round, ans.a1), 'done');
  assert.equal(ans.a2.score, undefined);
  assert.equal(statusOf(round, ans.a2), 'skipped');
  assert.deepEqual(progress(round, ans), { done: 1, partial: 0, skipped: 1, todo: 0, total: 2, finished: 2 });
  // a score alone is complete: comments are never needed unless the admin marks one required
  assert.equal(statusOf(round, { na: false, score: 3 }), 'done');
  // a comment without the required score is "started"
  assert.equal(statusOf(round, { na: false, comment: 'hi' }), 'partial');
  assert.equal(statusOf(round, blank()), 'todo');
  // typing an answer cancels "haven't worked with them"
  assert.equal(cleanAnswers(round, { a1: { na: true, comment: 'hi' } }).a1.na, false);
  // unknown fields and bad values are dropped
  assert.deepEqual(cleanAnswers(round, { a1: { score: 2.5, bogus: 1, comment: 5 } }).a1, { na: false });
});
t('warnings flag only people who still need an answer', () => {
  const w = warnings(round, { a1: { na: false, score: 3 }, a2: blank() });
  assert.deepEqual(w.map(x => [x.id, x.text]), [['a2', 'not answered yet']]);
  const w2 = warnings(round, { a1: { na: false, comment: 'x' }, a2: { na: true } });
  assert.match(w2[0].text, /still needs: Overall suitability/);
  assert.equal(w2.length, 1);
});
t('next unanswered wraps round and skips the finished', () => {
  const r3 = cleanRound({ title: 'T', applicants: parseNames('A\nB\nC') });
  const ans = { a1: { na: true }, a2: blank(), a3: { na: false, score: 4 } };
  assert.equal(nextUnanswered(r3, ans, -1).id, 'a2');
  assert.equal(nextUnanswered(r3, ans, 1).id, 'a2');   // from B, round the ring, only B is left
  assert.equal(nextUnanswered(r3, { a1: { na: true }, a2: { na: true }, a3: { na: true } }, -1), null);
});
t('custom questions: required text, several scales', () => {
  const r = cleanRound({ title: 'T', applicants: parseNames('A\nB'), questions: [
    { id: 'team', type: 'scale', label: 'Teamwork', required: true }, { id: 'clin', type: 'scale', label: 'Clinical', required: false },
    { id: 'why', type: 'text', label: 'Why', required: true }] });
  assert.equal(scaleQuestions(r).length, 2);
  const ans = cleanAnswers(r, { a1: { team: 4, why: 'good' }, a2: { team: 5 } });
  assert.equal(statusOf(r, ans.a1), 'done');
  assert.equal(statusOf(r, ans.a2), 'partial');
  assert.match(warnings(r, ans)[0].text, /still needs: Why/);
});
t('form body uses the right fields and skips what was not answered', () => {
  const wired = cleanRound({ applicants: [{ id: 'a1', name: 'X', entry: { score: 11, comment: 12 } }, { id: 'a2', name: 'Y', entry: { score: 21, comment: 22 } }], form: { id: 'a'.repeat(30), nameEntry: 99 } });
  const ans = cleanAnswers(wired, { a1: { score: 5, comment: ' Great ' }, a2: { na: true } });
  const p = formBody(wired, 'Dr A', ans);
  assert.equal(p.get('entry.99'), 'Dr A'); assert.equal(p.get('entry.11'), '5'); assert.equal(p.get('entry.12'), 'Great');
  assert.equal(p.has('entry.21'), false);
  assert.match(formUrl(wired), /^https:\/\/docs\.google\.com\/forms\/d\/e\/a{30}\/formResponse$/);
});
t('summary and CSV (formula-safe), one scale and many', () => {
  const subs = [
    { name: 'P', at: 0, answers: cleanAnswers(round, { a1: { score: 4, comment: '=cmd()' }, a2: { score: 2, comment: 'a, "b"' } }) },
    { name: 'Q', at: 0, answers: cleanAnswers(round, { a1: { score: 5 }, a2: { na: true } }) },
  ];
  const s = summary(round, subs);
  assert.equal(s[0].scales[0].mean, 4.5); assert.equal(s[0].scales[0].n, 2); assert.equal(s[1].skipped, 1); assert.equal(s[1].comments.length, 1);
  assert.equal(s[1].scales[0].mean, 2); assert.equal(s[0].answered, 2);
  const csv = resultsCSV(round, subs);
  assert.match(csv, /'=cmd\(\)/); assert.match(csv, /"a, ""b"""/);
  assert.match(csv, /Lee Wei,Q,[^,]+,\(did not work with them\),yes/);
  assert.match(answersText(round, 'P', subs[0].answers), /Overall suitability for residency: 4/);
  const r = cleanRound({ title: 'T', applicants: parseNames('A'), questions: [{ id: 'x', type: 'scale', label: 'X' }, { id: 'y', type: 'scale', label: 'Y' }, { id: 'c', type: 'text', label: 'C' }] });
  const s2 = summary(r, [{ name: 'P', at: 0, answers: cleanAnswers(r, { a1: { x: 2, y: 5, c: 'hi' } }) }, { name: 'Q', at: 0, answers: cleanAnswers(r, { a1: { x: 4 } }) }]);
  assert.deepEqual(s2[0].scales.map(z => [z.id, z.n, z.mean]), [['x', 2, 3], ['y', 1, 5]]);
});
t('photos: only plain base64 JPEG data of sane size shows; file names find the right person', () => {
  assert.equal(photoSrc('/9j/4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(photoSrc('<script>'), null); assert.equal(photoSrc(''), null); assert.equal(photoSrc(5), null);
  assert.equal(photoSrc('A'.repeat(80001)), null);
  const r = cleanRound({ title: 'T', applicants: parseNames('Lim Zhan Foong\nLim Zhan Foong Junior\nNg Joo Yang, Kevin\nTan Mei Xin') });
  assert.equal(matchPhotoFile(r, 'ng-joo-yang-kevin.jpg').name, 'Ng Joo Yang, Kevin');
  assert.equal(matchPhotoFile(r, 'Tan Mei Xin 2.PNG').name, 'Tan Mei Xin');
  assert.equal(matchPhotoFile(r, 'IMG_2231.jpg'), null);
  assert.equal(matchPhotoFile(r, 'lim zhan foong.jpg').name, 'Lim Zhan Foong', 'an exact name wins');
  assert.equal(matchPhotoFile(r, 'lim zhan.jpg'), null, 'two people share the start of the name: no guess');
});
t('demo round has made-up names, photos and the standard questions', () => {
  const d = demoRound();
  assert.equal(d.applicants.length, 8);
  assert.ok(cleanRound(d));
  assert.match(demoPhoto(3), /^data:image\/svg\+xml/);
  assert.deepEqual(d.questions.map(q => q.id), DEFAULT_QUESTIONS.map(q => q.id));
});
t('open and close dates', () => {
  const r = { shared: true, status: 'open', opensAt: 1000, closesAt: 2000 };
  assert.equal(roundState(r, 999), 'before');
  assert.equal(roundState(r, 1000), 'open');
  assert.equal(roundState(r, 1999), 'open');
  assert.equal(roundState(r, 2000), 'after');
  assert.equal(roundState({ ...r, status: 'closed' }, 1500), 'closed');
  assert.equal(roundState({ shared: true, status: 'open', opensAt: null, closesAt: null }, 5), 'open');
  assert.equal(roundState({ applicants: [] }, 5), 'open', 'a link round has no dates');
  assert.equal(roundState(null), 'closed');
  const ms = new Date(2026, 9, 30, 17, 5).getTime();
  assert.equal(toLocalInput(ms), '2026-10-30T17:05');
  assert.equal(fromLocalInput('2026-10-30T17:05'), ms);
  assert.equal(fromLocalInput(''), null);
  assert.equal(fromLocalInput('soon'), null);
  assert.equal(toLocalInput(null), '');
});

console.log(`applicants model: ${n} groups passed`);

t('mirror is kept only for a wired round with the standard two questions', () => {
  const wired = { applicants: [{ id: 'a1', name: 'X', entry: { score: 1, comment: 2 } }], form: { id: 'a'.repeat(30), nameEntry: 5 } };
  assert.equal(cleanRound({ ...wired, mirror: true }).mirror, true);
  assert.equal(cleanRound({ ...wired }).mirror, undefined);
  assert.equal(cleanRound({ applicants: [{ id: 'a1', name: 'X' }], mirror: true }).mirror, undefined);
  const custom = cleanRound({ ...wired, mirror: true, questions: [{ id: 'teamwork', type: 'scale', label: 'T' }] });
  assert.equal(custom.mirror, undefined);
  assert.equal(canMirror(cleanRound({ ...wired })), true);
});

t('a new passcode is readable, without look-alikes, and different each time', () => {
  assert.equal(newPasscode(new Uint8Array(12)), 'aaaa-aaaa-aaaa');
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const c = newPasscode(); assert.match(c, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/); seen.add(c); }
  assert.ok(seen.size > 190);
  assert.deepEqual(CODE_ROLES.map(r => r.id), ['guest', 'setup', 'committee']);
});
t('a passcode must be 6 to 100 characters and differ from the other roles (ignoring case and spaces)', () => {
  assert.equal(codeProblem('guest', 'maple-tree-42'), '');
  assert.match(codeProblem('guest', ' abc12 '), /at least 6/);
  assert.match(codeProblem('guest', 'x'.repeat(101)), /at most 100/);
  assert.match(codeProblem('guest', ' Quiet-River-7 ', { committee: 'quiet-river-7', setup: 'other-code-9' }), /already the committee passcode/);
  assert.equal(codeProblem('guest', 'quiet-river-7', { guest: 'quiet-river-7' }), '', 'keeping its own is fine');
  assert.equal(codeProblem('setup', 'fresh-code-1', { guest: undefined, committee: '' }), '');
});
