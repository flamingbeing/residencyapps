# Notes

Lasting rules, owner preferences and lessons (never task chatter), and how to test.

## What it is

Confidential feedback on residency applicants: a 1 to 5 suitability score and a comment for each (or the questions the
round sets), as in the department's Google Form it replaced. Built inside another app first and moved to this repo and its
own Firebase project in Oct 2026 (the people it is about are applicants, and many respondents have no account there).

## Who signs in, and what they can do

- **Passcodes** (`worker/guest.js`, `POST /api/guest` on residencyapps.anawj.com only): the Worker checks the passcode and
  returns a Firebase custom token (claim `guest: true` and `role`, no email). Three roles:
  - `guest`: answers (residents, faculty, anyone asked). The name is optional, so answers can be anonymous; names are not checked.
  - `setup`: the round, photos and questions; never the answers.
  - `committee`: reads every answer and who said what; changes nothing.
  Anyone holding a passcode has that role: share them like keys. Tries are capped at 10 a minute per address (`GUEST_LIMIT`).
- **Admins**: a Google sign-in whose email is in `admins/{email}` (added by hand in the Firebase console; the owner's account
  first). They see everything, keep the committee list, change the passcodes and run the retention delete. They don't answer.
- **Committee list**: `selectionCommittee/{email}`, Google sign-ins that read the results (kept by admins).

## Data (Firestore, rules in `firestore.rules`)

- `selection/{cycle}`: the round `{ title, status, applicants, questions, opensAt?, closesAt?, form?, mirror? }`.
- `selection/{cycle}/photos/{applicantId}`: a passport crop, bare base64 JPEG in `jpeg` (the rules check type and size only).
- `selection/{cycle}/responses/{id}`: one per guest (`guest-<uid>`). Answers copied from the first home keep their email ids
  and stay readable in Results.
- `selectionCodes/{guest|setup|committee}`: the passcodes `{ code, updatedAt }`, set on Set up › Sign-in passcodes. One set
  there replaces the Worker secret of the same role (`GUEST_PASSCODE`, `SETUP_PASSCODE`, `COMMITTEE_PASSCODE`); a role with
  none uses its secret, and if the store can't be read the secrets still work (so a Firebase problem never locks everyone
  out). The Worker reads them with a service sign-in (claim `codesReader`) when `FIREBASE_API_KEY` and `FIREBASE_PROJECT`
  are set (`wrangler.jsonc`). Kept as plain text on purpose (admins want to see them): the rules are the lock.

## Rules that bite

- **Open and close dates** (`opensAt`, `closesAt`, ms): the rules compare them with `request.time`, so answers outside the
  window are refused without any scheduled job, and a phone with the wrong clock can't get round it. Closing by hand
  (`status: closed`) stops answers at once.
- **Retention delete** (Set up › After the selection, admins): closes the round, then deletes every response and photo in
  batches. Typing the intake confirms it. Firestore TTL would delete only documents, not subcollections, so it stays a button.
- **Applicant ids come from names** (`a1`, `a2`… kept for an unchanged name): renaming someone makes a new applicant, so
  their old answers and photo stop matching. Fix typos before answers arrive.
- **A published round beats a link round** in `loadRound`. Link rounds (`#r=…`, answers on the device or posted to a Google
  Form) are the first version, kept for a round that isn't published.
- **Set up opens locked** (`<fieldset disabled>`); Unlock to edit; it locks again after 5 minutes, a save, or Lock. A new
  card goes inside `lockable(...)` or it stays editable while locked.
- **Autosave on the device** while typing (`sel-ans-<cycle>-<id>`); demo keys start `sel-demo-` and never touch a real round.
- Signing out wipes the offline copy (shared ward PCs).

## How to test

- `node test/model.test.mjs`: the logic. `node test/e2e.mjs`: every role in the demo at phone size, with axe
  (`AXE_PATH=<axe.min.js>`). `bash tools/test-rules.sh`: the rules in the emulator (Java). `node tools/check.mjs`: repo
  checks and Worker tests. All run in Checks on every PR.
- Demo: `?demo` (`=guest`, `=setup`, `=committee`, `=admin`; `=reset` starts over); the account sheet switches role.

## Set up once (Firebase and Cloudflare)

Firebase project `residencyapps`: Firestore, Google sign-in (admins), authorised domain residencyapps.anawj.com, the web
config in `applicants/js/firebase-config.js` and its API key in `wrangler.jsonc` vars, rules deployed from
`firestore.rules`, and the owner's email in `admins/`. A role-less service account signs the tokens: its key and email go in
the Worker secrets `GUEST_SA_KEY` and `GUEST_SA_EMAIL`, with the three passcode secrets. Never in this repo.
