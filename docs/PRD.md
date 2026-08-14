# Hermes Voice — PRD / Implementation Plan

A private, installable mobile web app (PWA) that gives the existing Hermes agent a
push-to-talk voice interface. The Ubuntu host stays headless.

**Status:** v1 implemented in this repo.

---

## 1. Problem

Hermes is a capable agent running headless on a personal Ubuntu server. Interacting
with it today means a terminal or the existing dashboard. There is no fast way to ask
it something out loud from a phone.

We want: open a private URL, tap to talk, hear Hermes answer, close the tab. No
desktop environment, no native app, no always-on wake word.

## 2. Goals / Non-goals

**Goals**
- Phone-first, installable PWA. Push-to-talk in v1, with optional server VAD.
- Real-time speech-to-speech with low latency.
- Hermes remains the source of truth for personality, memory, tools, and credentials.
- No long-lived provider keys in the browser, ever.
- Clean session teardown; graceful reconnect after brief network loss.
- Low idle resource use on the server.

**Non-goals (v1)**
- Telephony / SIP. Native iOS/Android apps. Desktop environment, VNC, RDP.
- Server administration through the voice UI.
- Replacing or duplicating Hermes's memory or tool system.

## 3. Architecture

The central decision: **the browser talks audio directly to the voice
provider (xAI or ElevenLabs), and talks tools through our server.** Audio
takes the short path (low latency); anything requiring trust takes the
server path. ElevenLabs is optional: set `ELEVENLABS_API_KEY` plus a
custom `ELEVENLABS_VOICE_ID`. When both providers are configured the PWA
exposes a picker. Voice ids (generated, cloned, designed) are applied as
a per-session TTS override so one agent can speak as Billy, Blacco, etc.

```
  ┌───────────────┐   1. login (cookie)      ┌──────────────────────┐
  │               │─────────────────────────>│  hermes-voice server │
  │  Phone (PWA)  │   2. POST /api/session   │  (Node, this repo)   │
  │               │<──── ephemeral token ────│                      │
  │               │                          │   XAI_API_KEY  ──────┼──┐
  │               │   4. tool call bridge    │   API_SERVER_KEY     │  │
  │               │<────────────────────────>│                      │  │
  └───────┬───────┘                          └───────────┬──────────┘  │
          │                                              │ 5. HTTP     │
          │ 3. audio in/out (WebSocket)                  │  Bearer     │
          │                                              v             │
          v                                   ┌──────────────────────┐ │
  ┌──────────────────────┐                    │   Hermes agent       │ │
  │  xAI Realtime Voice  │<───────────────────┤   127.0.0.1:8642     │ │
  │  grok-voice-latest   │   mint token ──────┘   (api_server)       │ │
  └──────────────────────┘<───────────────────────────────────────────┘
```

**Why not proxy the audio through our server?** It would double bandwidth, add a hop
of latency to every audio frame, and put a Node process on the critical path of a
real-time stream. The ephemeral-token pattern is what xAI documents for browsers and
it keeps the long-lived key server-side, which is the actual security requirement.

### 3.1 Division of labour between the two models

Grok 4.5 stays the Hermes reasoning model. `grok-voice-latest` is a *voice front-end*,
not a replacement brain. It handles listening, turn-taking, barge-in, and speaking.

The voice model is given exactly **one** function tool:

```
ask_hermes(request: string) -> string
```

Anything that needs memory, tools, files, or real knowledge goes through it. This is
deliberate — it satisfies "do not duplicate Hermes's tool system" by construction.
Mirroring Hermes's full toolset into the realtime session would fork the tool registry
and drift the moment Hermes gains a tool.

Trade-off: a Hermes round-trip costs a beat of latency. Mitigated by instructing the
voice model to acknowledge naturally ("let me check") before calling, and by
`ask_hermes` being a single hop rather than a chain.

### 3.2 Session identity and the trust boundary

The browser **never supplies the Hermes session id.** On login the server creates a
Hermes session and stores the id in server-side session state keyed by a signed,
HttpOnly cookie. `/api/hermes/ask` resolves the Hermes session from the cookie alone.

This matters: if the client passed its own session id, anyone with a valid cookie
could read or write arbitrary Hermes sessions, including those belonging to other
gateway platforms (Slack, WhatsApp). The cookie-only path makes that unreachable.

### 3.3 Verified external contracts

Confirmed against xAI docs and the Hermes source at `gateway/platforms/api_server.py`.

**xAI**
- `POST https://api.x.ai/v1/realtime/client_secrets`
  → body `{ expires_after: { seconds }, session: {...} }`, response `{ value, expires_at }`.
  Max 3600s; we default to 600s.
- `wss://api.x.ai/v1/realtime?model=grok-voice-latest`
- Browser auth: WebSocket **subprotocol** `xai-client-secret.{value}` — browsers cannot
  set WS headers.
- Audio: PCM16 little-endian, 24 kHz, base64 in `input_audio_buffer.append`.
- Client events: `session.update`, `input_audio_buffer.append|commit|clear`,
  `conversation.item.create`, `response.create`, `response.cancel`.
- Server events: `session.updated`, `response.output_audio.delta`,
  `response.output_audio_transcript.delta`, `conversation.item.input_audio_transcription.*`,
  `response.function_call_arguments.done`, `response.done`, `error`.
- Reconnect: `resumption: { enabled: true }` + `?conversation_id=<id>`.

**Hermes** (`api_server` platform, default `127.0.0.1:8642`)
- Auth: `Authorization: Bearer $API_SERVER_KEY`.
- `POST /api/sessions` → `{ id?, title?, system_prompt?, model? }`
- `POST /api/sessions/{id}/chat` → `{ message }` ⇒ `{ message: { role, content }, session_id, usage }`
- `GET /health`
- `X-Hermes-Session-Key` optionally scopes long-term memory.

## 4. User experience

1. Open the private URL (Tailscale hostname) on the phone.
2. Enter the passphrase once; a signed cookie persists for `SESSION_TTL_HOURS`.
3. Big talk button. **Hold to talk** by default; toggle to **hands-free** (server VAD).
4. Speak — audio streams live; Hermes answers aloud.
5. Tap while it is speaking to interrupt (barge-in).
6. Mute, end session, and a rolling transcript with tool-activity indicators.
7. Brief network drops reconnect automatically and resume the conversation.

## 5. Security

| Concern | Decision |
|---|---|
| Provider keys | `XAI_API_KEY` and `API_SERVER_KEY` are server-side only, never serialised to the client. |
| Browser credential | Ephemeral xAI token, default 600s, minted per session start. |
| App auth | Passphrase → signed HttpOnly/Secure/SameSite=Lax cookie, server-side session store, absolute expiry. |
| Passphrase storage | `scrypt` hash comparison, constant-time; never logged. |
| Brute force | Strict rate limit on `/api/auth/login` (5/15min), general limit elsewhere. |
| Transport | HTTPS required — `getUserMedia` needs a secure context. |
| Network exposure | Tailscale (or equivalent) first; public exposure is opt-in and documented, not default. |
| Logging | Central redaction of key-shaped values; tokens and audio never logged. |
| Session end | Explicit `POST /api/session/end` closes the WS and drops server-side state. |

## 6. Implementation

Single npm package. Fastify server, Vite + vanilla TypeScript client — no UI framework,
per the "small and maintainable" constraint.

```
server/src/
  config.ts         env parsing + validation, fails fast
  logger.ts         redacting logger
  auth.ts           scrypt passphrase, signed cookies, session store
  hermes-client.ts  typed Hermes api_server client
  xai-client.ts     ephemeral token minting
  voice-session.ts  persona + tool schema for session.update
  routes/           auth, session, hermes bridge
client/src/
  realtime.ts       xAI WS client, reconnect w/ resumption
  audio/            AudioWorklet capture (PCM16 24k) + gapless playback
  ui.ts, main.ts    talk button, transcript, status
  sw.ts             service worker (app shell only)
```

**Audio.** `AudioContext({ sampleRate: 24000 })`, an AudioWorklet capture node emitting
Int16 frames, and a second worklet with a ring buffer for gapless playback. Worklets
rather than the deprecated `ScriptProcessorNode`, and a ring buffer rather than
scheduling `AudioBufferSourceNode`s, because chained sources click at chunk boundaries.

**Barge-in.** On user speech start: flush the playback ring buffer and send
`response.cancel`. Local flush comes first so it feels instant.

## 7. Verification

- `npm run typecheck` — server and client.
- `npm test` — vitest: config validation, passphrase/cookie auth, session-store
  isolation, Hermes client contract, token minting (mocked `fetch`), and the
  redaction logger.
- Manual: `GET /health` reports Hermes reachability; phone smoke test over Tailscale.

## 8. Prerequisites needing your input

1. **`XAI_API_KEY`** with Realtime Voice access.
2. **`API_SERVER_KEY`** — the value your running Hermes gateway already uses for the
   `api_server` platform (that platform must be enabled).
3. **`APP_PASSWORD`** — chosen by you at deploy time.
4. **HTTPS origin** — Tailscale Serve gives this for free; otherwise a reverse proxy
   with a certificate.

## 9. Deliberately deferred

Multi-user accounts, WebRTC transport, custom voice cloning, streaming partial Hermes
responses into speech (`/chat/stream` exists and is the natural v2), offline transcript
history, wake word.
