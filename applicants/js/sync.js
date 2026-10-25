// Sending answers through app-sync (core.anawj.com/sync/, one exact version, cloud.js loads it): a response goes to an
// outbox on this device first (IndexedDB), then to the server in a transaction, so an answer sent with no signal survives
// a reload and goes by itself once the device is back online, and a refused one (the round closed) is reported, never lost
// silently. The SDK's own offline queue is never used for answers. The other writes (the round, photos, the committee,
// passcodes, the retention delete) still go straight to the SDK (cloud.js docs): they are counted here (track), so the
// status and the sign-out check know they are not on the server yet.
// The wiring is app-sync's createApp (0.6.0): its write queue, outbox and Firestore adapter; nothing is watched (the
// screens read through cloud.js docs), and sign-out runs forgetDevice on createApp's parts (force skips the unsent check).
// The engine (AS), the Firebase SDK and the browser bits are passed in, so test/sync.test.mjs runs it in Node.
//
// createSaving({ AS, sdk, store, online, persist, storage }) -> { activate, send, track, status, canReload, signOut, onChange, queue, app }
//   AS: app-sync's index.js. sdk: async () -> { A, F, auth, db }. store: the outbox (default residencyapps-outbox).
//   online: () -> bool. persist: async () -> { persisted, supported } (default AS.persistGuard). storage: createApp's.

// selection/{cycle}/responses/{id}: the kind carries the round, so one outbox holds every round's answers
export const KIND = cycle => 'responses@' + cycle;
const cycleOf = kind => String(kind).replace(/^responses@/, '');
const replace = (_current, record) => record;

export function createSaving({ AS, sdk, store = null, online = () => globalThis.navigator?.onLine !== false, persist = () => AS.persistGuard(), storage }) {
  const others = new Set();   // writes sent straight to the SDK, not yet on the server
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } };
  const nav = { get onLine() { return online(); }, get userAgent() { return globalThis.navigator?.userAgent || ''; } };
  // a kind is responses@<cycle>; createApp hands it to the adapter as the collection, so path finds the round
  const app = AS.createApp({
    name: 'residencyapps', colls: ['responses'], path: (_owner, kind) => ['selection', cycleOf(kind), 'responses'], sdk, nav,
    ...(store ? { outbox: store } : {}), ...(storage !== undefined ? { storage } : {}), watchEvery: 0,
    // the whole response replaces what is there, as setDoc did (one per person, only they write it); updatedAt is this
    // device's time, serverAt the server's (stampMode 'server': the rules require serverAt == request.time)
    backend: {
      merge: new Proxy({}, { getOwnPropertyDescriptor: () => ({ value: replace, writable: true, enumerable: true, configurable: true }), get: () => replace }),
      stamp: doc => ({ ...doc, updatedAt: Date.now() }), stampMode: 'server',
    },
    queue: { otherPending: async () => others.size > 0 },
  });
  const { queue } = app;
  let owner = null;
  queue.onChange(notify);
  globalThis.addEventListener?.('online', notify);
  globalThis.addEventListener?.('offline', notify);
  let persisted = true, confirmed = false, sending = 0;

  return {
    queue, app,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // at sign-in: this person's unsent answers (from before a reload) start going again
    async activate(id) {
      owner = id;
      await app.open(id);
      persist().then(r => { persisted = !!r.persisted || !r.supported; notify(); }, () => {});
    },
    // the server answered (a read not from the cache): the status may say synced from now on
    heard() { if (!confirmed) { confirmed = true; notify(); } },
    // -> { state: 'sent' } once the server has it, { state: 'waiting' } when it is kept here to go later (offline, slow),
    //    or throws what the server said (the round closed, no access): the save is set aside then, nothing goes twice
    async send(cycle, record, ms = 8000) {
      const kind = KIND(cycle);
      sending++; notify();
      try {
        await app.save(kind, owner, record, null);
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
    // a write sent straight to the SDK: counted until it settles (either way)
    track(p) {
      const t = Promise.resolve(p).catch(() => {});
      others.add(t); notify();
      t.finally(() => { others.delete(t); notify(); });
      return p;
    },
    status: () => AS.syncStatus({
      online: online(), pending: queue.pending(), attention: AS.attentionCount(queue.entries()), unsent: others.size,
      persisted, confirmed, atRiskOnlyOffline: true,
    }),
    // the update module's take-over reload waits while this says no
    canReload: () => sending === 0 && queue.pending() === 0 && others.size === 0,
    // Sign-out on a shared ward PC: refused while anything is unsent (unless force), then the outbox and the SDK's own
    // offline copy go. -> { ok: true } or { ok: false, unsent: true }
    async signOut({ force = false, before = async () => {} } = {}) {
      if (!force && !(await queue.flush())) return { ok: false, unsent: true };
      await before();
      const { hub, stores, adapter } = app.parts;
      const r = await AS.forgetDevice({ hub, stores, queue, clearBackendCache: () => adapter.clearCache() });
      owner = null;
      await app.open('');
      if (r.failed.length) console.warn('Sign-out: could not clear', r.failed.join(', '));
      return { ok: true };
    },
  };
}
