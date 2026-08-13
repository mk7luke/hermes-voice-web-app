/**
 * Login, logout, and session probe.
 *
 * Login is the one unauthenticated write endpoint in the app, so it carries the
 * strictest rate limit.
 */

import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE, verifyPassword } from '../auth.js';
import type { AppContext } from '../context.js';
import { COOKIE_OPTIONS, issueSession, requireSession } from '../context.js';

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, logger, sessions } = context;

  const cookieOptions = { ...COOKIE_OPTIONS, secure: config.cookieSecure };

  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
      schema: {
        body: {
          type: 'object',
          // Nothing to require in proxy mode, and demanding a passphrase the
          // deployment does not have would reject the request before the
          // handler could issue a session.
          required: config.authMode === 'passphrase' ? ['password'] : [],
          properties: {
            password: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      // In proxy mode there is no passphrase to check and the PWA never shows
      // the login form, but the endpoint stays reachable: a stale client, or a
      // bookmark, should get a working session rather than an error about a
      // passphrase this deployment does not have.
      if (config.authMode === 'proxy' || !config.appPassword) {
        const session = issueSession(context, reply);
        return reply.send({ ok: true, expiresAt: session.expiresAt });
      }

      const { password } = request.body as { password: string };

      const ok = await verifyPassword(password, config.appPassword, context.passwordSalt);
      if (!ok) {
        logger.warn('failed login attempt', { ip: request.ip });
        return reply.code(401).send({ error: 'invalid_password' });
      }

      const session = issueSession(context, reply);
      logger.info('login succeeded', { ip: request.ip, sessionId: session.id.slice(0, 8) });

      return reply.send({ ok: true, expiresAt: session.expiresAt });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const session = requireSession(context, request, reply);
    if (session) {
      sessions.destroy(session.id);
    }
    // Clear the cookie regardless — logging out should always leave the browser
    // in a clean state, even if the session had already expired.
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const session = requireSession(context, request, reply);
    if (!session) return reply;
    return reply.send({
      authenticated: true,
      expiresAt: session.expiresAt,
      hasActiveConversation: session.hermesSessionId !== null,
    });
  });
}
