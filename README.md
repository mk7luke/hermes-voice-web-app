# Hermes Voice

A self-hosted, installable voice interface (PWA) for the [Hermes agent](https://github.com/NousResearch/hermes-agent).
Open a URL on your phone, hold a button, talk to Hermes. The server stays headless.

## Affiliation & trademarks

**Hermes Voice is an independent, unofficial project.** It is not
affiliated with, endorsed by, or sponsored by [Nous Research](https://nousresearch.com)
or [xAI](https://x.ai).

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) is © Nous Research,
  released under the [MIT License](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE).
  “Hermes” / “Hermes Agent” refer to that upstream project; this app is a
  third-party voice UI that connects to a self-hosted Hermes instance.
- xAI Realtime Voice / Grok are services of xAI. Use of those APIs is subject to
  [xAI’s Enterprise Terms](https://x.ai/legal/terms-of-service-enterprise),
  [Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy), and
  [Brand Guidelines](https://x.ai/legal/brand-guidelines). You must supply your
  own `XAI_API_KEY`; never commit keys.

You run it yourself, on your own hardware, against your own agent. It is single-user
by design — one passphrase, one conversation — which keeps the trust model small
enough to read in an afternoon.

Audio runs browser ↔ xAI Realtime Voice or ElevenLabs Agents for low latency.
Everything that needs trust — memory, tools, credentials — stays with Hermes
behind this server. Custom ElevenLabs voice ids (generated, cloned, designed)
are first-class: pick them in the PWA.

See [`docs/PRD.md`](docs/PRD.md) for the design and the reasoning behind it.

---

## How it fits together

```
Phone (PWA) ──audio──> xAI Realtime  OR  ElevenLabs Agents (voice_id)
     │                        │
     │                   ask_hermes tool call
     │                        v
     └──cookie auth──> hermes-voice server ──Bearer──> Hermes (127.0.0.1:8642)
                       (holds all secrets)              Grok + memory + tools
```

The voice model handles listening and speaking. It gets exactly one tool,
`ask_hermes`, so every real request goes to Hermes — no duplicated tool registry
to keep in sync.

The browser never receives `XAI_API_KEY` or `API_SERVER_KEY`. It gets a
short-lived xAI ephemeral token (default 10 minutes), minted per session.

## Requirements

- Node.js 20.11+, **or** Docker with Compose (Linux — see
  [Run with Docker](#run-with-docker))
- A running Hermes agent with the `api_server` gateway platform enabled
- An `XAI_API_KEY` with Realtime Voice access, **or**
  `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` (or both)
- HTTPS (browsers refuse microphone access otherwise)

## Enable the Hermes API server

This app talks to Hermes through its `api_server` platform. On the Hermes host:

```bash
hermes gateway   # confirm the api_server platform is enabled
curl -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/health
```

If that returns JSON, you are ready. Use the same `API_SERVER_KEY` value below.

## Install

Two supported ways to run this: Node directly, or Docker Compose. Both read the
same `.env`, so configure that first either way.

```bash
git clone https://github.com/mk7luke/hermes-voice-web-app.git
cd hermes-voice-web-app
cp .env.example .env && chmod 600 .env
$EDITOR .env          # fill in the required values
```

For the Node path, also build:

```bash
npm ci
npm run build
```

With Docker, skip those two — the image builds itself.

Generate the session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Required variables — see `.env.example` for the full annotated list:

| Variable | Purpose |
|---|---|
| `XAI_API_KEY` | xAI key with Realtime Voice access. Server-side only. Optional if ElevenLabs is set. |
| `ELEVENLABS_API_KEY` | ElevenLabs key. Server-side only. Optional if xAI is set. |
| `ELEVENLABS_VOICE_ID` | Required with the ElevenLabs key. Any custom / generated / cloned id. |
| `VOICE_PROVIDER` | `xai` or `elevenlabs`. Default when both providers are configured. |
| `API_SERVER_KEY` | Bearer key for the Hermes `api_server` platform. |
| `AUTH_MODE` | `passphrase` (default) or `proxy`. See [Authentication](#authentication). |
| `APP_PASSWORD` | Passphrase for the web app. Required unless `AUTH_MODE=proxy`. |
| `SESSION_SECRET` | ≥32 chars, signs session cookies. |

Everything else has a working default. The server refuses to start if a required
value is missing, and tells you which one.

## Run

```bash
node --env-file=.env dist/server/index.js
```

Then check it:

```bash
curl http://127.0.0.1:8787/health
# {"status":"ok","hermes":"reachable","sessions":0}
```

`"hermes":"unreachable"` means this app is fine but cannot see the agent — check
`HERMES_API_URL` and that the `api_server` platform is running.

## Run with Docker

```bash
docker compose up -d --build
docker compose logs -f
curl http://127.0.0.1:8787/health
```

That is the whole setup. The image builds the client and server itself, so you
do not need Node, `npm ci`, or `npm run build` on the host — only a `.env`.

```bash
docker compose ps          # STATUS shows healthy once /health returns 200
docker compose restart     # after editing .env
docker compose up -d --build   # after pulling new code
docker compose down        # stop and remove
```

Three things about this setup are deliberate and worth knowing before you change
them:

**Host networking, no port mapping.** Hermes' `api_server` binds strictly to
`127.0.0.1:8642`, and a container on a bridge network cannot reach a
loopback-bound service on the host — `host.docker.internal` does not help,
because nothing is listening on the bridge gateway address. The alternative,
rebinding Hermes to `0.0.0.0`, would widen your agent's exposure. So the
container joins the host network namespace instead. `HOST` and `PORT` from
`.env` therefore control the bind directly, exactly as they did without Docker,
and `tailscale serve` in front of it works unchanged.

Host networking is a Linux feature. On Docker Desktop for macOS or Windows it
behaves differently, and this compose file assumes Linux — which is where you
would be running Hermes anyway.

**No configuration in the image.** `.env` is excluded by `.dockerignore` and
injected at run time through `env_file`, so the image holds no secrets and is
safe to rebuild, tag, or discard. Nothing here needs a registry.

**Restarts are already handled.** `restart: unless-stopped` plus a `/health`
healthcheck means Compose replaces the systemd unit below — you want one or the
other, not both.

Logs are JSON-file capped at 3 × 10 MB, so an unattended box will not fill its
disk with transcript noise.

## Authentication

By default the app authenticates the browser itself: one passphrase
(`APP_PASSWORD`), exchanged for a signed session cookie that expires after
`SESSION_TTL_HOURS`.

If you already run an identity-aware proxy in front of it — Cloudflare Access, a
Tailscale ACL, oauth2-proxy — that passphrase is a second login for the same
person. Set `AUTH_MODE=proxy` and leave `APP_PASSWORD` empty to drop it:

```bash
AUTH_MODE=proxy
APP_PASSWORD=
```

**This only holds if the origin cannot be reached except through that proxy.**
A `cloudflared` tunnel, a tailnet-only address, or a loopback bind satisfies
that; an open port does not. In `proxy` mode the app performs no authentication
of its own, so anything that reaches the port is inside — and the port is the
front door to an agent holding your memory, files, and credentials. The server
prints a warning naming this assumption at every boot.

Setting both `AUTH_MODE=proxy` and a non-empty `APP_PASSWORD` is refused at
startup rather than silently ignored, so nobody is left believing a passphrase
still guards the app.

Sessions work the same way in both modes. The cookie is not the authentication
in `proxy` mode — it is what binds a browser to its own Hermes session, so one
client can never name another's conversation. A caller without a valid cookie is
issued a fresh session instead of a 401; a caller with a *tampered* cookie is
still rejected, because a bad signature means something is wrong rather than
missing.

## Secure remote access

**Do this before exposing anything.** Tailscale gives you a private network and
a valid HTTPS certificate without opening a port to the internet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
sudo tailscale status   # shows your https://<host>.<tailnet>.ts.net URL
```

Open that URL on your phone. You get HTTPS (so the microphone works), and only
devices on your tailnet can reach it.

Keep `HOST=127.0.0.1` so the Node process is never directly reachable — Tailscale
is the only way in.

If you later expose this publicly, put it behind a reverse proxy with a real
certificate, keep `COOKIE_SECURE=true`, and treat `APP_PASSWORD` as the only
thing standing between the internet and your agent. Tailscale is strongly
preferred.

## Install on your phone

1. Open the HTTPS URL in Safari (iOS) or Chrome (Android).
2. Enter your passphrase.
3. **Share → Add to Home Screen** (iOS) or **⋮ → Install app** (Android).
4. Launch it from the home screen — it opens standalone, without browser chrome.

Grant the microphone permission when prompted. iOS only offers this over HTTPS.

## Using it

| Control | Behaviour |
|---|---|
| **Hold to talk** | Press and hold, speak, release. Releasing ends your turn. |
| **Hands-free** | Tap the mode button. Server VAD detects when you stop speaking. |
| **Interrupt** | Press the talk button while Hermes is speaking. |
| **Mute** | Stops sending microphone audio without ending the session. |
| **End** | Closes the socket, releases the microphone, clears the conversation. |

Brief network drops reconnect automatically and resume the same conversation.
The microphone is released whenever you end a session or background the app.

## Run as a service

Skip this if you used Docker Compose — `restart: unless-stopped` already does
the same job. This is the equivalent for a plain Node install.

```ini
# /etc/systemd/system/hermes-voice.service
[Unit]
Description=Hermes Voice
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hermes
WorkingDirectory=/opt/hermes-voice-web-app
EnvironmentFile=/opt/hermes-voice-web-app/.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure
RestartSec=5

# The service needs no write access and no privileges.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown root:hermes /opt/hermes-voice-web-app/.env
sudo chmod 640 /opt/hermes-voice-web-app/.env
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-voice
sudo journalctl -u hermes-voice -f
```

Idle cost is a single Node process holding no connections — sessions exist only
while you are talking.

## Development

```bash
npm run dev          # server on :8787, serving the built client
npm run dev:client   # Vite dev server with HMR, proxying /api to :8787
npm test             # vitest
npm run typecheck    # server + client
```

For local development over `http://localhost`, set `COOKIE_SECURE=false`.
Browsers treat `localhost` as a secure context, so the microphone still works.

### Layout

```
server/src/    Fastify server — config, auth, Hermes + xAI clients, routes
client/src/    Vite + vanilla TypeScript PWA — audio, realtime socket, UI
client/public/worklets/   AudioWorklet processors (capture + playback)
tests/         Vitest suite (config, auth, clients, routes, realtime, elevenlabs)
scripts/       PWA icon generation
docs/PRD.md    Design document
Dockerfile          Two-stage build; runtime image carries no configuration
docker-compose.yml  Host-networked service, env_file, /health healthcheck
```

### Tests

```
tests/config.test.ts    environment validation
tests/auth.test.ts      passphrase, cookie signing, session store
tests/clients.test.ts   Hermes + xAI contracts, log redaction
tests/realtime.test.ts  realtime session lifecycle, reconnect, superseded sockets
tests/routes.test.ts    end-to-end routes, including session isolation
```

The authorisation tests are the ones worth keeping green: they assert that no
route reaches Hermes without a valid cookie, and that a client cannot choose
which Hermes session it talks to.

## Security notes

- Long-lived keys never leave the server. The browser holds only an ephemeral
  xAI token that expires on its own.
- The Hermes session id is resolved from the signed cookie, never from the
  request body — a client cannot address another conversation.
- Login is rate limited to 5 attempts per 15 minutes per IP.
- Logs pass through a redaction layer; audio is never logged.
- The service worker never caches `/api/*`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Talk button does nothing | Not on HTTPS, or microphone permission denied. |
| `hermes: unreachable` | Hermes down, or `api_server` platform not enabled. |
| 503 `xai_unavailable` | `XAI_API_KEY` invalid or lacks Realtime Voice access. |
| Logged out repeatedly | Server restarted — sessions are in-memory by design. |
| Login screen still appears with `AUTH_MODE=proxy` | The server did not start in proxy mode; check the boot log for the `AUTH_MODE=proxy` warning. |
| Cannot install to home screen | Must be HTTPS with the manifest reachable. |
| Container stuck `unhealthy` | `/health` is probed on `PORT` from `.env`; a `PORT` the app is not bound to never answers. |
| Container healthy, `hermes: unreachable` | `network_mode: host` was changed, or `HERMES_API_URL` does not point at the host's loopback. |

## Not in v1

Telephony/SIP, native apps, multi-user accounts, wake word, offline history.
Streaming Hermes responses into speech token-by-token (Hermes exposes
`/chat/stream`) is the natural next step.

## Contributing

Bug reports and focused fixes are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for setup and conventions. Open an issue before building anything large; the scope
above is deliberate.

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

**Found a security problem?** Do not open a public issue — see
[SECURITY.md](SECURITY.md). This app fronts an agent holding real credentials, so
disclosure goes to email first.

## License

[MIT](LICENSE) © 2026 Luke
