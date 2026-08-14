/**
 * End-to-end route tests against a real Fastify instance with fake upstreams.
 *
 * The load-bearing tests here are the authorisation ones: that no route touches
 * Hermes without a valid cookie, and that a client cannot choose which Hermes
 * session it talks to.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../server/src/app.js';
import { SessionStore } from '../server/src/auth.js';
import { loadConfig } from '../server/src/config.js';
import type { AppContext } from '../server/src/context.js';
import { HermesClient } from '../server/src/hermes-client.js';
import { createLogger } from '../server/src/logger.js';
import { XaiClient } from '../server/src/xai-client.js';

const PASSWORD = 'correct-horse-battery';

interface Harness {
  app: FastifyInstance;
  context: AppContext;
  hermesChat: ReturnType<typeof vi.fn>;
  hermesCreateSession: ReturnType<typeof vi.fn>;
  mintToken: ReturnType<typeof vi.fn>;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({
    XAI_API_KEY: 'xai-test',
    API_SERVER_KEY: 'hermes-test',
    APP_PASSWORD: PASSWORD,
    SESSION_SECRET: 'y'.repeat(40),
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
    ...env,
  });

  const logger = createLogger('error', () => {});

  const hermes = new HermesClient({
    baseUrl: config.hermesApiUrl,
    apiKey: config.hermesApiKey,
    sessionKey: null,
    timeoutMs: 1_000,
    logger,
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
  });
  const xai = new XaiClient({
    apiKey: config.xaiApiKey,
    logger,
    fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
  });

  let counter = 0;
  const hermesCreateSession = vi.fn(async () => `api_session_${++counter}`);
  const hermesChat = vi.fn(async () => 'Hermes says hello.');
  const mintToken = vi.fn(async () => ({ value: 'ephemeral-token', expiresAt: 9_999_999 }));

  hermes.createSession = hermesCreateSession as unknown as HermesClient['createSession'];
  hermes.chat = hermesChat as unknown as HermesClient['chat'];
  hermes.health = (async () => true) as HermesClient['health'];
  xai.createEphemeralToken = mintToken as unknown as XaiClient['createEphemeralToken'];

  const context: AppContext = {
    config,
    logger,
    sessions: new SessionStore(config.sessionTtlMs),
    hermes,
    xai,
    elevenlabs: null,
    passwordSalt: 'test-salt',
  };

  return { app: await buildApp(context), context, hermesChat, hermesCreateSession, mintToken };
}

/** Log in and return the session cookie. */
async function login(app: FastifyInstance, password = PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password },
  });
  const cookie = response.cookies[0];
  if (!cookie) throw new Error('login did not set a cookie');
  return `${cookie.name}=${cookie.value}`;
}

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.app.close();
});

describe('authentication', () => {
  it('rejects a wrong passphrase', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.cookies).toHaveLength(0);
  });

  it('sets an HttpOnly SameSite cookie on success', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const cookie = response.cookies[0] as unknown as Record<string, unknown>;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
  });

  it('rejects a login with no password field', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('recognises a valid session', async () => {
    const cookie = await login(h.app);
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().authenticated).toBe(true);
  });

  it('invalidates the session on logout', async () => {
    const cookie = await login(h.app);
    await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a forged cookie signature', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'hv_session=fabricated-id.fabricated-signature' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('protected routes', () => {
  it.each([
    ['POST', '/api/session/start'],
    ['POST', '/api/session/end'],
    ['POST', '/api/hermes/ask'],
    ['GET', '/api/auth/me'],
  ])('rejects unauthenticated %s %s', async (method, url) => {
    const response = await h.app.inject({
      method: method as 'GET' | 'POST',
      url,
      payload: method === 'POST' ? { callId: 'c1', request: 'hi' } : undefined,
    });
    expect(response.statusCode).toBe(401);
  });

  it('never reaches Hermes without authentication', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      payload: { callId: 'c1', request: 'exfiltrate everything' },
    });
    expect(h.hermesChat).not.toHaveBeenCalled();
  });
});

describe('session start', () => {
  it('returns an ephemeral token and never the long-lived key', async () => {
    const cookie = await login(h.app);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: { turnMode: 'push_to_talk' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token).toBe('ephemeral-token');
    expect(body.realtimeUrl).toBe('wss://api.x.ai/v1/realtime');
    expect(body.sampleRate).toBe(24000);

    // The serialised response must not contain either upstream secret.
    expect(response.body).not.toContain('xai-test');
    expect(response.body).not.toContain('hermes-test');
  });

  it('exposes exactly one tool to the voice model', async () => {
    const cookie = await login(h.app);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: {},
    });

    const tools = response.json().session.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('ask_hermes');
  });

  it('disables server VAD for push-to-talk and enables it for hands-free', async () => {
    const cookie = await login(h.app);

    const ptt = await h.app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: { turnMode: 'push_to_talk' },
    });
    expect(ptt.json().session.turn_detection).toBeNull();

    const handsFree = await h.app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: { turnMode: 'hands_free' },
    });
    expect(handsFree.json().session.turn_detection.type).toBe('server_vad');
  });

  it('reuses the Hermes session across reconnects', async () => {
    const cookie = await login(h.app);
    await h.app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie }, payload: {} });
    await h.app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie }, payload: {} });

    // Two starts, one Hermes session — otherwise a flaky network would shred
    // conversation continuity.
    expect(h.hermesCreateSession).toHaveBeenCalledTimes(1);
  });

  it('reports Hermes being down as a 503', async () => {
    h.hermesCreateSession.mockRejectedValueOnce(new Error('connection refused'));
    const cookie = await login(h.app);

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('hermes_unavailable');
  });
});

describe('Hermes tool bridge', () => {
  async function startedSession(): Promise<string> {
    const cookie = await login(h.app);
    await h.app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie }, payload: {} });
    return cookie;
  }

  it('forwards a tool call and returns the answer', async () => {
    const cookie = await startedSession();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      headers: { cookie },
      payload: { callId: 'call_1', request: 'What is on my calendar?' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ callId: 'call_1', output: 'Hermes says hello.' });
    expect(h.hermesChat).toHaveBeenCalledWith('api_session_1', 'What is on my calendar?');
  });

  it('ignores any session id supplied by the client', async () => {
    const cookie = await startedSession();

    await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      headers: { cookie },
      payload: {
        callId: 'call_1',
        request: 'hi',
        // A malicious client trying to reach someone else's conversation.
        sessionId: 'slack_private_session',
        hermesSessionId: 'slack_private_session',
      },
    });

    // The cookie-bound session is used; the injected id is not.
    expect(h.hermesChat).toHaveBeenCalledWith('api_session_1', 'hi');
  });

  it('keeps two logged-in browsers on separate Hermes sessions', async () => {
    const first = await startedSession();
    const second = await login(h.app);
    await h.app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie: second }, payload: {} });

    await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      headers: { cookie: first },
      payload: { callId: 'a', request: 'from first' },
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      headers: { cookie: second },
      payload: { callId: 'b', request: 'from second' },
    });

    expect(h.hermesChat).toHaveBeenNthCalledWith(1, 'api_session_1', 'from first');
    expect(h.hermesChat).toHaveBeenNthCalledWith(2, 'api_session_2', 'from second');
  });

  it('refuses a tool call before a session has started', async () => {
    const cookie = await login(h.app);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      headers: { cookie },
      payload: { callId: 'call_1', request: 'hi' },
    });

    expect(response.statusCode).toBe(409);
    expect(h.hermesChat).not.toHaveBeenCalled();
  });

  it('returns speakable text rather than an error when Hermes fails', async () => {
    h.hermesChat.mockRejectedValueOnce(new Error('boom'));
    const cookie = await startedSession();

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      headers: { cookie },
      payload: { callId: 'call_1', request: 'hi' },
    });

    // A 200 with spoken text: the voice model needs something to say, and
    // silence on a phone reads as a hang.
    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toBe(true);
    expect(response.json().output).toMatch(/could not reach Hermes/i);
  });

  it('rejects an oversized request body', async () => {
    const cookie = await startedSession();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hermes/ask',
      headers: { cookie },
      payload: { callId: 'call_1', request: 'x'.repeat(9_000) },
    });

    expect(response.statusCode).toBe(400);
    expect(h.hermesChat).not.toHaveBeenCalled();
  });
});

describe('session end', () => {
  it('clears the Hermes binding but keeps the login', async () => {
    const cookie = await login(h.app);
    await h.app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie }, payload: {} });
    await h.app.inject({ method: 'POST', url: '/api/session/end', headers: { cookie } });

    // Still authenticated...
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().hasActiveConversation).toBe(false);

    // ...but the next start opens a genuinely new conversation.
    await h.app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie }, payload: {} });
    expect(h.hermesCreateSession).toHaveBeenCalledTimes(2);
  });
});

describe('health', () => {
  it('reports Hermes reachability without authentication', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', hermes: 'reachable' });
  });

  it('leaks no configuration detail', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/health' });
    expect(response.body).not.toContain('xai-test');
    expect(response.body).not.toContain('hermes-test');
    expect(response.body).not.toContain('8642');
  });
});

describe('AUTH_MODE=proxy', () => {
  const PROXY_ENV = { AUTH_MODE: 'proxy', APP_PASSWORD: '' };

  it('serves an authenticated session without a cookie', async () => {
    // The identity-aware proxy already decided, and the origin is not reachable
    // around it, so there is nothing left for the app to authenticate.
    const { app } = await harness(PROXY_ENV);
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(200);
    expect(response.json().authenticated).toBe(true);
    expect(response.cookies[0]?.name).toBe('hv_session');
    await app.close();
  });

  it('still binds each browser to its own Hermes session', async () => {
    // Dropping the passphrase must not drop the session model: the Hermes
    // session id stays server-side, keyed by a cookie the client cannot forge.
    const { app, hermesCreateSession } = await harness(PROXY_ENV);

    const first = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const cookie = `${first.cookies[0]!.name}=${first.cookies[0]!.value}`;

    const start = { turnMode: 'push_to_talk' as const };
    await app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie }, payload: start });
    await app.inject({ method: 'POST', url: '/api/session/start', headers: { cookie }, payload: start });
    // Same browser reuses one Hermes session...
    expect(hermesCreateSession).toHaveBeenCalledTimes(1);

    // ...a different browser gets its own.
    await app.inject({ method: 'POST', url: '/api/session/start', payload: start });
    expect(hermesCreateSession).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('still rejects a tampered cookie rather than replacing it', async () => {
    const { app } = await harness(PROXY_ENV);
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'hv_session=forged.signature' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_session');
    await app.close();
  });

  it('accepts a login with no passphrase instead of erroring', async () => {
    const { app } = await harness(PROXY_ENV);
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    await app.close();
  });

  it('leaves passphrase mode untouched', async () => {
    const { app } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('not_authenticated');
    await app.close();
  });
});
