// Residency applications offline support, on the shared update module (app-update 0.2.0, core.anawj.com/update/): it
// installs every SHELL file or nothing, and a new version waits (waitForGo) until the page says go, which it does only
// when no one is typing or sending (js/app-update.js, canReload). The deploy stamps VERSION (tools/stamp-versions.mjs:
// 'applicants-v1' becomes 'applicants-<date>-<hash>'); never change it by hand. Change the v<N> only when this file's own
// logic changes.
//
// The app's own files, the design kit (design.anawj.com/v1/), the sync engine and the update module are in SHELL; the
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
  // the sync engine (app-sync), one exact version: answers sent offline go only with it
  'https://core.anawj.com/sync/0.4.0/index.js',
  'https://core.anawj.com/sync/0.4.0/src/sync.js',
  'https://core.anawj.com/sync/0.4.0/src/writes.js',
  'https://core.anawj.com/sync/0.4.0/src/conflict.js',
  'https://core.anawj.com/sync/0.4.0/src/store.js',
  'https://core.anawj.com/sync/0.4.0/src/outbox.js',
  'https://core.anawj.com/sync/0.4.0/src/watchdog.js',
  'https://core.anawj.com/sync/0.4.0/src/persist.js',
  'https://core.anawj.com/sync/0.4.0/src/status.js',
  'https://core.anawj.com/sync/0.4.0/src/forget.js',
  'https://core.anawj.com/sync/0.4.0/src/firestore.js',
  // the page half of the update module (register.js), one exact version: the page starts it offline too
  'https://core.anawj.com/update/0.2.0/register.js',
];

const MANIFEST = {};

importScripts('https://core.anawj.com/update/0.2.0/sw-core.js');
AppUpdate.init({
  app: 'applicants', version: VERSION, shell: SHELL, manifest: MANIFEST, waitForGo: true,
  // "Get the latest version" checks for signal by fetching sw.js; the passcode sign-in is never cached
  never: [/\/sw\.js$/, /\/api\//],
  runtime: [
    // the kit's /v1/ changes compatibly: answer from the cache, refresh in the background
    { name: 'kit', match: 'https://design.anawj.com/v1/', strategy: 'stale-while-revalidate', max: 40 },
    // exact versions (the address carries it): never change
    { name: 'pinned', match: /^https:\/\/core\.anawj\.com\/(sync|update)\/\d+\.\d+\.\d+\//, strategy: 'cache-first', max: 40 },
  ],
});
