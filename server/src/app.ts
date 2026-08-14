/**
 * Fastify application assembly.
 *
 * Split from index.ts so tests can build an app around fake clients without
 * binding a port or reading the environment.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { AppContext } from './context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHermesRoutes } from './routes/hermes.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerVoiceRoutes } from './routes/voice.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Built client assets, resolved for both `dist/server/` and `server/src/` layouts. */
function resolveClientDir(): string | null {
  const candidates = [
    join(here, '../client'), // dist/server/app.js -> dist/client
    join(here, '../../dist/client'), // server/src/app.ts -> dist/client
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}

export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Our own redacting logger handles application logging; Fastify's built-in
    // logger would emit headers (including Cookie) unredacted.
    logger: false,
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    // Keyed by IP. On a Tailscale-only deployment this is effectively
    // per-device, which is the granularity we want.
    keyGenerator: (request) => request.ip,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      context.logger.error('unhandled request error', {
        method: request.method,
        url: request.url,
        error,
      });
    }
    void reply.code(status).send({
      error: status >= 500 ? 'internal_error' : (error.code ?? 'request_error'),
      message: status >= 500 ? 'Something went wrong.' : error.message,
    });
  });

  // --- Health ---------------------------------------------------------------
  // Unauthenticated by design so a supervisor can probe it, and deliberately
  // free of any configuration detail.
  app.get('/health', async (_request, reply) => {
    const hermesReachable = await context.hermes.health();
    return reply.code(hermesReachable ? 200 : 503).send({
      status: hermesReachable ? 'ok' : 'degraded',
      hermes: hermesReachable ? 'reachable' : 'unreachable',
      sessions: context.sessions.size,
    });
  });

  registerAuthRoutes(app, context);
  registerSessionRoutes(app, context);
  registerVoiceRoutes(app, context);
  registerHermesRoutes(app, context);

  // --- Static PWA -----------------------------------------------------------
  const clientDir = resolveClientDir();
  if (clientDir) {
    await app.register(fastifyStatic, { root: clientDir, index: ['index.html'] });

    // Single-page fallback: any non-API GET renders the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    context.logger.warn(
      'client assets not found — run `npm run build:client` to serve the PWA',
    );
  }

  return app;
}
