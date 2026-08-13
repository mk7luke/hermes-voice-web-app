/**
 * Shared application context, assembled once at boot and passed to routes.
 *
 * Explicit wiring rather than Fastify decorators so that tests can construct a
 * context directly with fakes.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppSession, SessionStore } from './auth.js';
import { SESSION_COOKIE, verifySessionId } from './auth.js';
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

/**
 * Resolve the caller's session from the signed cookie, or reply 401.
 *
 * Returns null when it has already sent the response, so callers should
 * `return` immediately on null.
 */
export function requireSession(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): AppSession | null {
  const cookie = request.cookies[SESSION_COOKIE];
  if (!cookie) {
    void reply.code(401).send({ error: 'not_authenticated' });
    return null;
  }

  const sessionId = verifySessionId(cookie, context.config.sessionSecret);
  if (!sessionId) {
    context.logger.warn('rejected a cookie with an invalid signature', {
      ip: request.ip,
    });
    void reply.code(401).send({ error: 'invalid_session' });
    return null;
  }

  const session = context.sessions.get(sessionId);
  if (!session) {
    void reply.code(401).send({ error: 'session_expired' });
    return null;
  }

  return session;
}
