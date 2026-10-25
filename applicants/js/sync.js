// Sending answers through app-sync (core.anawj.com/sync/, one exact version, cloud.js loads it): a response goes to an
// outbox on this device first (IndexedDB), then to the server in a transaction, so an answer sent with no signal survives
// a reload and goes by itself once the device is back online, and a refused one (the round closed) is reported, never lost
// silently. The SDK's own offline queue is never used for answers. The other writes (the round, photos, the committee,
// passcodes, the retention delete) still go straight to the SDK (cloud.js docs): they are counted here (track), so the
// status and the sign-out check know they are not on the server yet.
// Pure wiring: the engine (AS), the Firestore handle and the browser bits are passed in, so test/sync.test.mjs runs it in Node.
//
// createSaving({ AS, sdk, store, online, persist }) -> { activate, send, track, status, canReload, signOut, onChange, queue }
//   AS: app-sync's index.js. sdk: async () -> { F, db }. store: the outbox (default AS.createOutbox). online: () -> bool.
//   persist: async () -> { persisted, supported } (default AS.persistGuard).

// selection/{cycle}/responses/{id}: the kind carries the round, so one outbox holds every round's answers
export const KIND = cycle => 'responses@' + cycle;
const cycleOf = kind => String(kind).replace(/^responses@/, '');
const replace = (_current, record) => record;

export function createSaving({ AS, sdk, store = null, online = () => globalThis.navigator?.onLine !== false, persist = () => AS.persistGuard() }) {
  const fs = AS.createFirestoreBackend({
    sdk, path: (_owner, kind) => ['selection', cycleOf(kind), 'responses'],
    // the whole response replaces what is there, as setDoc did (one per person, only they write it); updatedAt is this
    // device's time, serverAt the server's (stampMode 'server': the rules require serverAt == request.time)
    merge: new Proxy({}, { getOwnPropertyDescriptor: () => ({ value: replace, writable: true, enumerable: true, configurable: true }), get: () => replace }),
    stamp: doc => ({ ...doc, updatedAt: Date.now() }), stampMode: 'server',
    onSnapshotMeta: () => {},
  });
  let owner = null;
  const others = new Set();   // writes sent straight to the SDK, not yet on the server
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } };
  const queue = AS.createWriteQueue({
    store: store || AS.createOutbox({ name: 'residencyapps-outbox' }), getOwner: () => owner, online,
    backend: (_owner, kind, record, base, extra) => fs.commit(owner, kind, record, base, extra),
    otherPending: async () => others.size > 0,
  });
  queue.onChange(notify);
  globalThis.addEventListener?.('online', () => { queue.kick(); notify(); });
  globalThis.addEventListener?.('offline', notify);
  let persisted = true, confirmed = false, sending = 0;

  return {
    queue,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // at sign-in: this person's unsent answers (from before a reload) start going again
    async activate(id) {
      owner = id;
      await queue.activate(id);
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
        await queue.save(kind, owner, record, null);
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
      const r = await AS.forgetDevice({ queue, clearBackendCache: () => fs.clearCache() });
      owner = null;
      if (r.failed.length) console.warn('Sign-out: could not clear', r.failed.join(', '));
      return { ok: true };
    },
  };
}
