# Status

## Now
- Live at residencyapps.anawj.com (23 Oct 2026); the old apmes address forwards here.

## Waiting on the owner
- Deploy `firestore.rules` (accepts both passcode claim shapes); then the Worker moves to app-devkit `custom-token.js`.
- Share the new link.

## Next
1. An alert for project `residencyapps` (the daily backup runs since 23 Oct).

## Recently done
- 25 Oct 2026: app-sync 0.6.0 → 0.6.3 (pin only: cloud.js, sw.js, test pin; answers use `backend.merge`, so held saves
  are not used; no rules change).
- 25 Oct 2026: app-sync 0.6.0 `createApp` for the answers outbox; rules accept app-devkit's claims shape too;
  `.starter.json` (adopted app-starter).
- 25 Oct 2026: app-sync 0.4.1 (answers through the outbox, status chip, `forgetDevice` at sign-out) and the update
  module 0.2.0 (offline shell, no reload while typing or sending); rules with `serverAt` deployed before the merge.
- 23 Oct 2026: cut-over: Firebase project `residencyapps` (rules, Google sign-in, domain), web config and key,
  Worker secrets, live round copied (counts match), old address forwards.
- 23 Oct 2026: app moved in and made to stand alone: passcode sign-in for everyone, Google for admins, own rules, open and
  close dates, retention delete, Checks (model, browser with axe, rules emulator).

## Decisions (dated, one line each)
- 23 Oct 2026: own repo, Firebase project and Worker; address residencyapps.anawj.com.
- 23 Oct 2026: everyone answers with the guest passcode (name optional); set-up and committee passcodes as before.
- 23 Oct 2026: one admin login: the owner's Google account (and any email in `admins/`, kept by hand).
- 23 Oct 2026: first version also has retention delete and open/close dates; vital app.
