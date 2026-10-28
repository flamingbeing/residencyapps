// Updates through the shared update module (app-sync's update module 1.5.2, its page half register.js at one exact address): a new
// version installs in the background and waits; the page gives it the go, and reloads once, only when canReload says
// so (no one typing, no sheet open, nothing sending). Checked on every return to the app, on coming back online and
// every 3 h. Loaded with import() so a blocked core address never stops the app (it then runs as it is).
const CORE = 'https://core.anawj.com/update/1.5.2/register.js';
let loading = null;

export async function startUpdates({ canReload = () => true } = {}) {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:' || new URLSearchParams(location.search).has('nosw')) return null;
  try {
    loading = import(CORE);
    return await (await loading).register({ app: 'applicants', sw: 'sw.js', canReload });
  } catch (e) { console.warn('Updates not started', e); return null; }
}
// try an owed reload now (a sheet closed, the last answer went)
export async function retryUpdate() { try { if (loading) (await loading).retryUpdate(); } catch {} }
