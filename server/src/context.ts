/**
 * Shared application context, assembled once at boot and passed to routes.
 *
 * Explicit wiring rather than Fastify decorators so that tests can construct a
 * context directly with fakes.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppSession, SessionStore } from './auth.js';
import { SESSION_COOKIE, signSessionId, verifySessionId } from './auth.js';
import type { Config } from './config.js';
import type { ElevenLabsClient } from './elevenlabs-client.js';
import type { HermesClient } from './hermes-client.js';
import type { Logger } from './logger.js';
import type { XaiClient } from './xai-client.js';

export interface AppContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly sessions: SessionStore;
  readonly hermes: HermesClient;
  readonly xai: XaiClient | null;
  readonly elevenlabs: ElevenLabsClient | null;
  /** Per-process salt for passphrase hashing. */
  readonly passwordSalt: string;
}

export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
};

/** Issue a fresh session and put its signed id in the response cookie. */
export function issueSession(
  context: AppContext,
  reply: FastifyReply,
): AppSession {
  const session = context.sessions.create();
  void reply.setCookie(
    SESSION_COOKIE,
    signSessionId(session.id, context.config.sessionSecret),
    {
      ...COOKIE_OPTIONS,
      secure: context.config.cookieSecure,
      maxAge: Math.floor(context.config.sessionTtlMs / 1000),
    },
  );
  return session;
}

/**
 * Resolve the caller's session from the signed cookie, or reply 401.
 *
 * Returns null when it has already sent the response, so callers should
 * `return` immediately on null.
 *
 * Under `AUTH_MODE=proxy` there is nothing to authenticate against: the proxy
 * in front already decided, and the origin is not reachable around it. A caller
 * without a usable cookie is therefore given a new session rather than a 401.
 * The cookie still exists, because the session is what binds this browser to a
 * Hermes session id — that binding is not an authentication mechanism, and a
 * client must never be able to name someone else's Hermes session.
 */
export function requireSession(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): AppSession | null {
  const trustProxy = context.config.authMode === 'proxy';

  const cookie = request.cookies[SESSION_COOKIE];
  if (!cookie) {
    if (trustProxy) return issueSession(context, reply);
    void reply.code(401).send({ error: 'not_authenticated' });
    return null;
  }

  const sessionId = verifySessionId(cookie, context.config.sessionSecret);
  if (!sessionId) {
    // Still worth refusing in proxy mode: a bad signature means a tampered or
    // stale-secret cookie, and silently replacing it would hide that.
    context.logger.warn('rejected a cookie with an invalid signature', {
      ip: request.ip,
    });
    void reply.code(401).send({ error: 'invalid_session' });
    return null;
  }

  const session = context.sessions.get(sessionId);
  if (!session) {
    if (trustProxy) return issueSession(context, reply);
    void reply.code(401).send({ error: 'session_expired' });
    return null;
  }

  return session;
}
