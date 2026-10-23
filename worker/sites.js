// The Cloudflare Worker for this repo's addresses. It serves the repo's files (the static assets, bound as ASSETS)
// and decides which folder an address may see (routes.js). No data, no storage: just files, plus the passcode sign-in
// on residencyapps.anawj.com (guest.js), the only part with secrets.
// wrangler.jsonc: "run_worker_first" sends every request here.
import { resolve } from './routes.js';
import { handleGuest, GUEST_HOST, GUEST_PATH } from './guest.js';

const NOINDEX = 'noindex, nofollow';

export default {
  async fetch(request, env) {
    const u0 = new URL(request.url);
    if (u0.hostname === GUEST_HOST && u0.pathname === GUEST_PATH) return handleGuest(request, env);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const url = new URL(request.url);
    const r = resolve(url.hostname, url.pathname);
    if (r.redirect) return redirect(url, r.redirect);
    if (r.notFound) return notFound();

    // a folder (address ending in "/") serves its index.html
    let file = r.file;
    if (file === '' || file.endsWith('/')) file += 'index.html';
    let res = await asset(env, url, file);
    if (res.status === 404 && !/\.[^/]+$/.test(file)) {
      // no such file, but a folder of that name: send the browser to the address with a "/" (as GitHub Pages does)
      const dir = await asset(env, url, file + '/index.html');
      if (dir.status === 200) return redirect(url, url.pathname + '/');
    }
    if (res.status === 404) return notFound();
    res = new Response(res.body, res);
    res.headers.set('X-Robots-Tag', NOINDEX);
    return res;
  },
};

const asset = (env, url, file) => env.ASSETS.fetch(new Request(new URL('/' + file, url), { method: 'GET' }));
const redirect = (url, path) => Response.redirect(new URL(path + url.search, url).toString(), 301);
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': NOINDEX } });
