# Status

## Now
- The app runs from this repo (demo works); not live yet: no Firebase project, Worker secrets or custom domain.

## Waiting on the owner
- A quiet time for the cut-over (the live round is copied, then the old address forwards here).

## Next (in order)
1. Cut-over: create Firebase project `residencyapps` (Firestore, Google sign-in, domain), deploy the rules, fill the web
   config and API key, the Worker secrets and custom domain, a Firestore backup; copy the live round; old address forwards.
2. Share the new link.

## Recently done
- 23 Oct 2026: app moved in and made to stand alone: passcode sign-in for everyone, Google for admins, own rules, open and
  close dates, retention delete, Checks (model, browser with axe, rules emulator).

## Decisions (dated, one line each)
- 23 Oct 2026: own repo, Firebase project and Worker; address residencyapps.anawj.com.
- 23 Oct 2026: everyone answers with the guest passcode (name optional); set-up and committee passcodes as before.
- 23 Oct 2026: one admin login: the owner's Google account (and any email in `admins/`, kept by hand).
- 23 Oct 2026: first version also has retention delete and open/close dates; vital app.
