# Status

## Now
- Live at residencyapps.anawj.com (23 Oct 2026); the old apmes address forwards here.

## Waiting on the owner
- Share the new link.

## Next
1. Daily Firestore backup and an alert for project `residencyapps`.

## Recently done
- 23 Oct 2026: cut-over: Firebase project `residencyapps` (rules, Google sign-in, domain), web config and key,
  Worker secrets, live round copied (counts match), old address forwards.
- 23 Oct 2026: app moved in and made to stand alone: passcode sign-in for everyone, Google for admins, own rules, open and
  close dates, retention delete, Checks (model, browser with axe, rules emulator).

## Decisions (dated, one line each)
- 23 Oct 2026: own repo, Firebase project and Worker; address residencyapps.anawj.com.
- 23 Oct 2026: everyone answers with the guest passcode (name optional); set-up and committee passcodes as before.
- 23 Oct 2026: one admin login: the owner's Google account (and any email in `admins/`, kept by hand).
- 23 Oct 2026: first version also has retention delete and open/close dates; vital app.
