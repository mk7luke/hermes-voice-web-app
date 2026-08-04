# Security Policy

## Reporting a vulnerability

**Email <92970468+mk7luke@users.noreply.github.com>.** Do not open a public issue,
and do not describe the problem in a pull request.

Please include what you need to demonstrate the issue — affected version or commit,
reproduction steps, and what an attacker gets out of it. A proof of concept helps.

This is a personal project maintained by one person, so there is no paid bounty and
no guaranteed response window. Expect a reply within about a week. If a report turns
out to be valid, you will be credited in the fix unless you would rather not be.

## Why this matters more than the size of the project suggests

This app is a front door to someone's personal Hermes agent. Behind it sit that
agent's long-term memory, its tool access, and the credentials it runs with. A
successful attack here is not "a toy voice demo broke" — it is access to a live
agent that can act on the operator's behalf.

Treat it accordingly, and expect us to.

## Supported versions

Only `main` receives fixes. There are no maintained release branches.

## The trust model

Worth understanding before deciding whether something is a bug or a design choice.

**What the server holds and never releases:** `XAI_API_KEY` and `API_SERVER_KEY`
stay server-side. The browser only ever receives a short-lived xAI ephemeral token
(default 10 minutes, capped by xAI at 1 hour).

**Authentication** is a single passphrase, hashed with `scrypt` and compared with
`timingSafeEqual`. Both the candidate and the configured passphrase are hashed
before comparison, so the timing of a failure reveals nothing about the real
passphrase's length. `APP_PASSWORD` must be at least 8 characters; `SESSION_SECRET`
must be at least 32, enforced at boot.

**Sessions.** The cookie carries only an opaque 32-byte random id plus an HMAC-SHA256
signature, verified with `timingSafeEqual`. Cookies are `httpOnly`, `sameSite=lax`,
and `secure` whenever `COOKIE_SECURE=true` (the default). Session state lives
server-side in memory.

**Session isolation.** The Hermes session id a browser is bound to is resolved
server-side from the signed cookie and is never read from the request body. A client
cannot name another conversation. `tests/routes.test.ts` asserts this.

**Rate limiting.** `POST /api/auth/login` is capped at 5 attempts per 15 minutes per
IP. It is the only unauthenticated write endpoint.

**Logging.** Log output passes through a redaction layer, and audio is never logged.

## Known and accepted limits

These are deliberate. Reporting them is fine, but they are unlikely to change.

- **Sessions are in memory.** A restart logs everyone out. Acceptable for a
  single-user app, and it means there is no session database to secure.
- **Single shared passphrase, no MFA, no accounts.** The app is single-user by
  design.
- **`HOST=127.0.0.1` and a fronting proxy are assumed.** The README recommends
  Tailscale. If you bind to `0.0.0.0` and expose the port directly, `APP_PASSWORD`
  becomes the only thing between the internet and the agent. That configuration is
  supported but not advised, and problems arising solely from it are operator
  choices rather than vulnerabilities.
- **Rate limiting is per IP and in memory**, so it does not survive a restart and
  does not coordinate across multiple instances.
- **The voice model is given exactly one tool, `ask_hermes`.** Prompt injection that
  persuades the voice layer to misbehave is bounded by that — it cannot reach
  anything Hermes would not already do for its operator. Ways to escape that
  boundary are very much in scope.

## Out of scope

- Findings that require an already-compromised host or a leaked `.env`.
- Missing hardening headers with no demonstrated impact.
- Automated scanner output with no working reproduction.
- Denial of service by flooding a self-hosted single-user app.
