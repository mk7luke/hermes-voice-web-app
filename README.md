# Hermes Voice

A private, installable voice interface (PWA) for the [Hermes agent](https://github.com/NousResearch/hermes-agent).
Open a URL on your phone, hold a button, talk to Hermes. The server stays headless.

Audio runs browser ↔ xAI Realtime Voice for low latency. Everything that needs
trust — memory, tools, credentials — stays with Hermes behind this server.

See [`docs/PRD.md`](docs/PRD.md) for the design and the reasoning behind it.

---

## How it fits together

```
Phone (PWA) ──audio──> xAI Realtime (grok-voice-latest)
     │                        │
     │                   ask_hermes tool call
     │                        v
     └──cookie auth──> hermes-voice server ──Bearer──> Hermes (127.0.0.1:8642)
                       (holds all secrets)              Grok 4.5 + memory + tools
```

The voice model handles listening and speaking. It gets exactly one tool,
`ask_hermes`, so every real request goes to Hermes — no duplicated tool registry
to keep in sync.

The browser never receives `XAI_API_KEY` or `API_SERVER_KEY`. It gets a
short-lived xAI ephemeral token (default 10 minutes), minted per session.

## Requirements

- Node.js 20.11+
- A running Hermes agent with the `api_server` gateway platform enabled
- An `XAI_API_KEY` with Realtime Voice access
- HTTPS (browsers refuse microphone access otherwise)

## Enable the Hermes API server

This app talks to Hermes through its `api_server` platform. On the Hermes host:

```bash
hermes gateway   # confirm the api_server platform is enabled
curl -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/health
```

If that returns JSON, you are ready. Use the same `API_SERVER_KEY` value below.

## Install

```bash
git clone https://github.com/mk7luke/hermes-voice-web-app.git
cd hermes-voice-web-app
npm ci
cp .env.example .env && chmod 600 .env
$EDITOR .env          # fill in the required values
npm run build
```

Generate the session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Required variables — see `.env.example` for the full annotated list:

| Variable | Purpose |
|---|---|
| `XAI_API_KEY` | xAI key with Realtime Voice access. Server-side only. |
| `API_SERVER_KEY` | Bearer key for the Hermes `api_server` platform. |
| `APP_PASSWORD` | Passphrase for the web app. |
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
npm test             # 76 tests
npm run typecheck    # server + client
```

For local development over `http://localhost`, set `COOKIE_SECURE=false`.
Browsers treat `localhost` as a secure context, so the microphone still works.

### Layout

```
server/src/    Fastify server — config, auth, Hermes + xAI clients, routes
client/src/    Vite + vanilla TypeScript PWA — audio, realtime socket, UI
client/public/worklets/   AudioWorklet processors (capture + playback)
tests/         Vitest suite
scripts/       PWA icon generation
docs/PRD.md    Design document
```

### Tests

```
tests/config.test.ts    environment validation
tests/auth.test.ts      passphrase, cookie signing, session store
tests/clients.test.ts   Hermes + xAI contracts, log redaction
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
| Cannot install to home screen | Must be HTTPS with the manifest reachable. |

## Not in v1

Telephony/SIP, native apps, multi-user accounts, wake word, offline history.
Streaming Hermes responses into speech token-by-token (Hermes exposes
`/chat/stream`) is the natural next step.
