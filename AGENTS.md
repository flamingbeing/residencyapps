# residencyapps

Instructions for every AI assistant working here (Claude Code reads this through `CLAUDE.md`).

NUHS Residency Applications (`applicants/`, live at residencyapps.anawj.com once set up): confidential feedback on
residency applicants from residents, faculty and others, read by the selection committee. Own Firebase project
`residencyapps`, own Worker `residencyapps`. **Vital app**: real feedback on real people; full tests before every merge.

## Public here, private elsewhere

Anything merged here is public. Keep only code, docs, general rules and **made-up** sample data. Never commit
secrets, tokens, personal data, real names or patient details. Private notes belong in the owner's private notes
repo; never copy anything from there into this repo, a PR or an issue (neutral pointers like "ask the owner" are fine).

## Rules that bite

- **No real names here, ever.** Applicants are real people and the feedback is confidential. Code and tests hold made-up
  demo data only; the real round lives in Firestore and in the owner's private notes.
- **Passcodes only for everyone but admins** (guest, set-up, committee; `worker/guest.js`). Admins are Google sign-ins
  listed by hand in `admins/` in the Firebase console. No passcode or secret goes in this repo.
- **Rules are vital:** every change to `firestore.rules` gets a case in `test/rules.emulator.mjs` and a green
  `bash tools/test-rules.sh` before merge. The collection names (`selection*`) stay as they are (copied data).
  On merge, `.github/workflows/deploy-firestore-rules.yml` tests and releases them (keyless; skips until its repo
  variables are set).
- Details and lessons: `NOTES.md`.

## Checks before merging

```
node .devkit/tools/check.mjs        # repo checks + Worker tests
node test/model.test.mjs    # the app's logic
node --test test/store.test.mjs   # every store read and write, through cloud.js
node .devkit/tools/proofread.mjs    # page and doc mistakes
```

Locally only those (plus `node test/e2e.mjs` when that is the spec being fixed). PR Checks on GitHub run the quick set (about 40 seconds: Chromium phone-size browser tests in parallel, rules, unit, proof-read) and gate merge and deploy; there is no WebKit, Firefox or jank gate here, so no separate full-checks workflow. Run the rest there, not locally first.

`.devkit/` (git-ignored) holds the kit's tools; CI copies it with `app-devkit/setup-tools@v1.6.0`. Locally:
`git clone --depth 1 --branch v1.6.0 https://github.com/flamingbeing/app-devkit /tmp/devkit && mkdir -p .devkit && cp -R /tmp/devkit/{tools,playwright,rules,worker} .devkit/`.

## Working with the owner

- Instructions mostly come from a phone. Work through a request to the end; ask only when a decision is genuinely
  the owner's. When asked to plan, plan and wait.
- Keep each PR small and finished on its own. Start PR titles with the app: "<App>: …".
- Merge your own PRs once the checks pass, then report with the PR link (merge by the number the PR creation
  returned) and call `unsubscribe_pr_activity`: each PR event re-sends the whole context.
- Push once per finished step, not after every small commit (limited build minutes).
- Each app keeps `NOTES.md` (lasting decisions, how to test) and `STATUS.md` (now, waiting on the owner, next,
  dated decisions). Read them before starting; update them when a task finishes. Cheap end of session: `quick-save`.
- Plain words, short; explain technical terms briefly the first time.

## Token savers

- `.claude/settings.json` is only read when a session has exactly one repo attached. Sessions usually attach the
  owner's notes repo as well; then the environment's shared settings apply instead, so keep both in step.
- `.claude/settings.json` denies reading `__/` and `vendor/` folders. Add generated files and very large files to its
  `deny` list (edit their build scripts instead), and say so here. Ask the owner if one is really needed.
- Run only the touched app's tests while iterating and the full run once before merge. Screenshots only for visual
  changes (one, viewport-sized); debug logic with text.
