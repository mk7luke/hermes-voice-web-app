# Contributing

Thanks for taking an interest. This is a small, focused project — a voice front-end
for a personal Hermes agent — and it works best if it stays that way.

## Before you build something big

Open an issue first for anything beyond a bug fix. The scope is deliberately narrow
(see [Not in v1](README.md#not-in-v1) in the README), and it is better to find out
that a feature is out of scope before you write it than after.

Small things — typos, doc corrections, a failing edge case with a test — just send
the PR.

## Getting set up

You need **Node.js 20.11 or newer** (`engines.node` in `package.json`).

```bash
git clone https://github.com/mk7luke/hermes-voice-web-app.git
cd hermes-voice-web-app
npm ci
cp .env.example .env && chmod 600 .env
$EDITOR .env
```

`.env.example` is annotated; every required variable explains what it is for. The
server validates configuration at boot and refuses to start with a clear message
naming the variable it is missing, so you will not get a mysterious runtime failure.

Generate `SESSION_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For local development over `http://localhost`, set `COOKIE_SECURE=false`. Browsers
treat `localhost` as a secure context, so the microphone still works.

You do **not** need a running Hermes instance to work on most of the codebase — the
test suite stubs the Hermes and xAI clients. You do need one to exercise a real
conversation end to end.

## The loop

```bash
npm run dev          # server on :8787, serving the built client
npm run dev:client   # Vite dev server with HMR, proxying /api to :8787
npm test             # Vitest, 95 tests
npm run typecheck    # server + client
```

`npm test` and `npm run typecheck` both need to pass before a PR is reviewable.
There is no lint step; match the style of the file you are editing.

## Tests

```
tests/config.test.ts    environment validation
tests/auth.test.ts      passphrase, cookie signing, session store
tests/clients.test.ts   Hermes + xAI contracts, log redaction
tests/realtime.test.ts  realtime session wiring
tests/routes.test.ts    end-to-end routes, including session isolation
```

**`tests/auth.test.ts` and `tests/routes.test.ts` are the ones that matter most.**
They assert two properties that this app's safety rests on:

1. No route reaches Hermes without a valid signed cookie.
2. A client cannot choose which Hermes session it talks to — the session id is
   resolved server-side from the cookie, never read from the request body.

If a change of yours makes either of those tests fail, the change is wrong, not the
test. If you believe the test is genuinely wrong, say so explicitly in the PR and
explain why — do not quietly adjust the assertion.

Bug fixes should come with a test that fails before the fix and passes after.

### What the suite cannot cover

Vitest runs in Node with the Hermes and xAI clients stubbed, so it never touches a
real microphone, a real browser, or a real network drop. If your change goes near any
of these, check it on a device and say so in the PR:

- **Microphone permission on iOS Safari.** Only offered over HTTPS — `localhost`
  counts, a bare LAN IP does not.
- **Add to Home Screen**, and that the app launches standalone without browser chrome.
- **Backgrounding the app mid-session.** The microphone must be released.
- **A brief network drop.** The session should reconnect and resume the same
  conversation rather than starting a new one.
- **Interrupting playback** by pressing talk while Hermes is speaking.

"I could not test this on iOS" is a perfectly good thing to write in a PR. Quietly
implying you did is not.

## Commits and pull requests

- Branch off `main`.
- Conventional-style subjects (`fix:`, `feat:`, `docs:`, `chore:`) — match what is
  already in `git log`.
- Explain *why* in the body. The diff shows what changed.
- Keep a PR to one concern. Two unrelated fixes are two PRs.

State in the PR what you actually ran. "Tests pass" is worth more when it says
`npm test → 95/95`.

## Touching security-relevant code

`server/src/auth.ts`, `server/src/context.ts`, `server/src/config.ts`, and
`server/src/routes/` sit between the public internet and someone's personal AI agent,
which holds their credentials, memory, and tools. Changes there get a closer read and
may take longer to merge. That is not distrust — the blast radius is just real.

Do not report a vulnerability in a pull request or a public issue. See
[SECURITY.md](SECURITY.md).

## Scope

This project is intentionally single-user. Multi-user accounts, telephony, native
apps, and wake-word support are out of scope — not "not yet", but a deliberate
decision to keep the trust model simple enough to reason about.

Streaming Hermes responses into speech token-by-token is the most wanted improvement
and is genuinely open.

## Code of Conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

By contributing, you agree that your contributions are licensed under the
[MIT Licence](LICENSE) that covers this project.
