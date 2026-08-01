/**
 * Login, logout, and session probe.
 *
 * Login is the one unauthenticated write endpoint in the app, so it carries the
 * strictest rate limit.
 */

import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE, signSessionId, verifyPassword } from '../auth.js';
import type { AppContext } from '../context.js';
import { requireSession } from '../context.js';

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, logger, sessions } = context;

  const cookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  };

  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            password: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const { password } = request.body as { password: string };

      const ok = await verifyPassword(password, config.appPassword, context.passwordSalt);
      if (!ok) {
        logger.warn('failed login attempt', { ip: request.ip });
        return reply.code(401).send({ error: 'invalid_password' });
      }

      const session = sessions.create();
      logger.info('login succeeded', { ip: request.ip, sessionId: session.id.slice(0, 8) });

      return reply
        .setCookie(SESSION_COOKIE, signSessionId(session.id, config.sessionSecret), {
          ...cookieOptions,
          maxAge: Math.floor(config.sessionTtlMs / 1000),
        })
        .send({ ok: true, expiresAt: session.expiresAt });
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
