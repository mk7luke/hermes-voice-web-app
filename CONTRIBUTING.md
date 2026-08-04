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
