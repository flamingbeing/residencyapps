# residencyapps

NUHS Residency Applications: confidential feedback on residency applicants. Respondents sign in with a passcode, score each
applicant and add a comment; the selection committee reads the results. Live at residencyapps.anawj.com once set up
(`?demo` shows made-up applicants and every role).

- `applicants/`: the app (static files; `js/app.js` screens, `js/model.js` logic, `js/store.js` Firestore, `js/cloud.js` sign-in)
- `firestore.rules`: who may read and write what (Firebase project `residencyapps`)
- `worker/`: the Cloudflare Worker that serves the app and the passcode sign-in (`guest.js`)
- `test/`: model, browser and rules tests; `tools/`: repo checks

How to work here: `AGENTS.md`. Lasting rules and lessons: `NOTES.md`. Now and next: `STATUS.md`.
