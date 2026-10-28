// Sending answers through app-sync (core.anawj.com/sync/, one exact version, cloud.js loads it): a response goes to an
// outbox on this device first (IndexedDB), then to the server in a transaction, so an answer sent with no signal survives
// a reload and goes by itself once the device is back online, and a refused one (the round closed) is reported, never lost
// silently. The SDK's own offline queue is never used for answers. The other writes (the round, photos, the committee,
// passcodes, the retention delete) still go straight to the SDK (cloud.js docs): they are counted here (track), so the
// status and the sign-out check know they are not on the server yet.
// The wiring is app-sync's module runner (1.x): createApp({ config, modules: [auth(), sync()] }). Sign-in stays the app's
// own (passcode or Google, cloud.js); the auth module follows Firebase and tells sync who is signed in: the outbox's
// scope is that person (email, or guest-<uid> for a passcode). Another account signing in on this device wipes the last
// one's outbox and offline copy first, and is refused (signed out again) while that one has answers not sent yet.
// Nothing is watched (the screens read through cloud.js docs). Sign-out is the auth module's forget: refused while
// anything is unsent (unless force), then the outbox and the SDK's own offline copy go (reopen gives a fresh one).
// The engine (core: index.js, createApp, auth, sync), the Firebase SDK and the browser bits are passed in, so
// test/sync.test.mjs runs it in Node.
//
// createSaving({ core, sdk, store, online, persist, storage, openDb }) -> Promise of
//   { send, track, status, canReload, signIn, signOut, onUser, blocked, heard, onChange, queue, app }
//   core: { AS (index.js), createApp, auth, sync }. sdk: async () -> { A, F, auth, db } (one object: reopen puts the
//   new db on it). store: the outbox (default residencyapps-outbox). online: () -> bool. persist: async () ->
//   { persisted, supported } (default AS.persistGuard). storage: createApp's. openDb(memory) -> a new Firestore instance.

// selection/{cycle}/responses/{id}: the kind carries the round, so one outbox holds every round's answers
export const KIND = cycle => 'responses@' + cycle;
const cycleOf = kind => String(kind).replace(/^responses@/, '');
const replace = (_current, record) => record;
// the outbox's scope: a Google sign-in's email, else the passcode account's uid
export const scopeOf = u => u.email ? u.email : 'guest-' + u.uid;
// a sign-in token the app fetched itself (cloud.js signInWithPasscode), signed in through the auth module so a refused
// switch is told
const token = { name: 'token', signIn: async (_sdk, { code }) => ({ token: code }) };

export async function createSaving({ core, sdk, store = null, online = () => globalThis.navigator?.onLine !== false, persist = () => core.AS.persistGuard(), storage, openDb = null }) {
  const { AS } = core;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } };
  const nav = { get onLine() { return online(); }, get userAgent() { return globalThis.navigator?.userAgent || ''; } };
  // a kind is responses@<cycle>; the module hands it to the adapter as the collection, so path finds the round
  const app = core.createApp({
    config: { name: 'residencyapps', sdk, ...(storage !== undefined ? { storage } : {}) },
    modules: [
      // popup first, as before (redirect only when popups are blocked or unsupported)
      core.auth({ methods: ['google', token], redirectFirst: () => false }),
      core.sync({
        colls: ['responses'], path: (_owner, kind) => ['selection', cycleOf(kind), 'responses'], scope: scopeOf, nav,
        ...(store ? { outbox: store } : {}), watchEvery: 0,
        // the whole response replaces what is there, as setDoc did (one per person, only they write it); updatedAt is
        // this device's time, serverAt the server's (stampMode 'server': the rules require serverAt == request.time)
        backend: {
          merge: new Proxy({}, { getOwnPropertyDescriptor: () => ({ value: replace, writable: true, enumerable: true, configurable: true }), get: () => replace }),
          stamp: doc => ({ ...doc, updatedAt: Date.now() }), stampMode: 'server',
        },
        // after a wipe: a new Firestore copy in place of the cleared one, so the next sign-in needs no reload
        ...(openDb ? { reopen: async ({ memory }) => openDb(memory) } : {}),
      }),
    ],
  });
  await app.ready;
  const s = app.sync, auth = app.auth, { queue } = s;
  queue.onChange(notify);
  globalThis.addEventListener?.('online', notify);
  globalThis.addEventListener?.('offline', notify);
  let persisted = true, confirmed = false, sending = 0;
  persist().then(r => { persisted = !!r.persisted || !r.supported; notify(); }, () => {});
  // the scope opens at sign-in (the module's scope): this person's answers not sent before a reload start going again
  const scope = () => { const u = auth.user(); return u ? scopeOf(u) : ''; };

  return {
    queue, app,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // cb(user | null) once known and on each change: after a switch's wipe, null when a switch was refused
    onUser: cb => auth.onUser(cb),
    // the last refused switch ({ reason: 'unsent' }: the last account's answers are still on this device) or null
    blocked: () => auth.blocked(),
    // { method: 'google' } or { method: 'token', code } -> { ok, reason } (auth.signIn's)
    signIn: request => auth.signIn(request),
    // the server answered (a read not from the cache): the status may say synced from now on
    heard() { if (!confirmed) { confirmed = true; notify(); } },
    // -> { state: 'sent' } once the server has it, { state: 'waiting' } when it is kept here to go later (offline, slow),
    //    or throws what the server said (the round closed, no access): the save is set aside then, nothing goes twice
    async send(cycle, record, ms = 8000) {
      const kind = KIND(cycle);
      sending++; notify();
      try {
        await s.save(kind, scope(), record, null);
        await queue.settle(kind, [record.id], ms);
        const job = queue.entries().find(x => x.kind === kind && x.record.id === record.id && x.state !== 'archived');
        if (!job || job.state === 'synced') return { state: 'sent' };
        if (job.state === 'failed' || job.state === 'conflict') {
          await queue.archive(job.key);
          const e = new Error(job.error || 'The server refused it.'); e.code = /permission/i.test(job.error) ? 'permission-denied' : 'failed';
          throw e;
        }
        return { state: 'waiting' };
      } catch (e) {
        // queue.save throws a failed save's copy-kept message; set it aside the same way
        for (const x of queue.entries()) if (x.kind === kind && x.record.id === record.id && (x.state === 'failed' || x.state === 'conflict')) await queue.archive(x.key);
        throw e;
      } finally { sending--; notify(); }
    },
    // a write sent straight to the SDK: counted until it settles (either way); it keeps a switch and sign-out shut too
    track(p) {
      s.track(p);
      notify();
      Promise.resolve(p).catch(() => {}).finally(() => setTimeout(notify, 0));
      return p;
    },
    status: () => AS.syncStatus({
      online: online(), pending: queue.pending(), attention: AS.attentionCount(queue.entries()), unsent: s.unsentOutside(),
      persisted, confirmed, atRiskOnlyOffline: true,
    }),
    // the update module's take-over reload waits while this says no
    canReload: () => sending === 0 && queue.pending() === 0 && s.unsentOutside() === 0,
    // Sign-out on a shared ward PC: refused while anything is unsent (unless force), then the outbox and the SDK's own
    // offline copy go (auth.forget). -> { ok: true } or { ok: false, unsent: true }
    async signOut({ force = false } = {}) {
      if (!force) await s.flush();
      const r = await auth.forget({ force });
      if (!r.ok) return { ok: false, unsent: true };
      if (r.failed.length) console.warn('Sign-out: could not clear', r.failed.join(', '));
      return { ok: true };
    },
  };
}
