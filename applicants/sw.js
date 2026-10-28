// Residency applications offline support, on the shared update module (app-sync's update module 1.5.2, core.anawj.com/update/): it
// installs every SHELL file or nothing, and a new version waits (waitForGo) until the page says go, which it does only
// when no one is typing or sending (js/app-update.js, canReload). The deploy stamps VERSION (tools/stamp-versions.mjs:
// 'applicants-v1' becomes 'applicants-<date>-<hash>'); never change it by hand. Change the v<N> only when this file's own
// logic changes.
//
// The app's own files, the design kits (design.anawj.com/v1/ and the app kit, app-ui), the sync engine and the update module are in SHELL; the
// Firebase SDK (gstatic, one exact version) is kept once fetched. The passcode sign-in (/api/), Firebase's sign-in pages
// (/__/), sw.js itself and everything else (Firestore, Google) always go to the network.
const VERSION = 'applicants-v1';
const SHELL = [
  './',
  'style.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/app-update.js',
  'js/cloud.js',
  'js/firebase-config.js',
  'js/model.js',
  'js/photo.js',
  'js/store.js',
  'js/sync.js',
  'js/ui.js',
  'icons/icon.svg',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'https://design.anawj.com/v1/tokens.css',
  'https://design.anawj.com/v1/app.css',
  'https://design.anawj.com/v1/app.js',
  // the app kit (app-ui: early.js, the theme CSS and the Look switch with its imports), one exact version: without it the app opens offline in the NUHS kit light look only
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/early.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/theme.css',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/index.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/choice.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/colour.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/grid.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/guard.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/looks.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/motion.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/palette-css.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/presets.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/schema.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/switch.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/looks/a.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/looks/b.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/looks/c.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/looks/d.js',
  'https://core.anawj.com/ui/1.0.0-rc.27/theme/looks/e.js',
  // the sync engine (app-sync: index.js and the app, auth and sync modules), one exact version: answers sent offline go only with it
  'https://core.anawj.com/sync/1.5.2/app.js',
  'https://core.anawj.com/sync/1.5.2/auth.js',
  'https://core.anawj.com/sync/1.5.2/index.js',
  'https://core.anawj.com/sync/1.5.2/src/auth.js',
  'https://core.anawj.com/sync/1.5.2/src/cache.js',
  'https://core.anawj.com/sync/1.5.2/src/conflict.js',
  'https://core.anawj.com/sync/1.5.2/src/core.js',
  'https://core.anawj.com/sync/1.5.2/src/firestore.js',
  'https://core.anawj.com/sync/1.5.2/src/forget.js',
  'https://core.anawj.com/sync/1.5.2/src/kinds.js',
  'https://core.anawj.com/sync/1.5.2/src/module-sync.js',
  'https://core.anawj.com/sync/1.5.2/src/outbox.js',
  'https://core.anawj.com/sync/1.5.2/src/persist.js',
  'https://core.anawj.com/sync/1.5.2/src/registry.js',
  'https://core.anawj.com/sync/1.5.2/src/replace.js',
  'https://core.anawj.com/sync/1.5.2/src/report.js',
  'https://core.anawj.com/sync/1.5.2/src/runner.js',
  'https://core.anawj.com/sync/1.5.2/src/signin/anonymous.js',
  'https://core.anawj.com/sync/1.5.2/src/signin/email-link.js',
  'https://core.anawj.com/sync/1.5.2/src/signin/passcode.js',
  'https://core.anawj.com/sync/1.5.2/src/signin/password.js',
  'https://core.anawj.com/sync/1.5.2/src/status.js',
  'https://core.anawj.com/sync/1.5.2/src/store.js',
  'https://core.anawj.com/sync/1.5.2/src/sync.js',
  'https://core.anawj.com/sync/1.5.2/src/user.js',
  'https://core.anawj.com/sync/1.5.2/src/view.js',
  'https://core.anawj.com/sync/1.5.2/src/watchdog.js',
  'https://core.anawj.com/sync/1.5.2/src/writes.js',
  'https://core.anawj.com/sync/1.5.2/sync.js',
  // the page half of the update module (register.js), one exact version: the page starts it offline too
  'https://core.anawj.com/update/1.5.2/register.js',
];

const MANIFEST = {};

importScripts('https://core.anawj.com/update/1.5.2/sw-core.js');
AppUpdate.init({
  app: 'applicants', version: VERSION, shell: SHELL, manifest: MANIFEST, waitForGo: true,
  // "Get the latest version" checks for signal by fetching sw.js; the passcode sign-in is never cached
  never: [/\/sw\.js$/, /\/api\//],
  runtime: [
    // the kit's /v1/ changes compatibly: answer from the cache, refresh in the background
    { name: 'kit', match: 'https://design.anawj.com/v1/', strategy: 'stale-while-revalidate', max: 40 },
    // exact versions (the address carries it): never change
    { name: 'pinned', match: /^https:\/\/core\.anawj\.com\/(sync|update|ui)\/\d+\.\d+\.\d+(-rc\.\d+)?\//, strategy: 'cache-first', max: 40 },
  ],
});
