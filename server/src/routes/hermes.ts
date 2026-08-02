/**
 * The tool bridge.
 *
 * When the voice model calls `ask_hermes`, the browser relays the call here.
 * This is the only route that reaches Hermes, and it resolves the target Hermes
 * session from the cookie — never from the request body. A client cannot name
 * the conversation it wants to talk to.
 */

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { requireSession } from '../context.js';
import { HermesError } from '../hermes-client.js';

/** Guards against a runaway voice model sending an unbounded transcript. */
const MAX_REQUEST_CHARS = 8_000;

export function registerHermesRoutes(app: FastifyInstance, context: AppContext): void {
  const { logger, hermes } = context;

  app.post(
    '/api/hermes/ask',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['callId', 'request'],
          properties: {
            callId: { type: 'string', minLength: 1, maxLength: 128 },
            request: { type: 'string', minLength: 1, maxLength: MAX_REQUEST_CHARS },
          },
        },
      },
    },
    async (request, reply) => {
      const session = requireSession(context, request, reply);
      if (!session) return reply;

      const { callId, request: userRequest } = request.body as {
        callId: string;
        request: string;
      };

      if (!session.hermesSessionId) {
        return reply.code(409).send({
          error: 'no_active_session',
          message: 'Start a voice session before sending requests to Hermes.',
        });
      }

      logger.info('bridging tool call to Hermes', {
        callId,
        sessionId: session.hermesSessionId,
        requestChars: userRequest.length,
      });

      try {
        const answer = await hermes.chat(session.hermesSessionId, userRequest);
        return reply.send({ callId, output: answer });
      } catch (error) {
        // Return a spoken-language failure rather than an HTTP error: the voice
        // model needs *something* to say. Silence on the phone reads as a
        // hang, which is a worse experience than "I couldn't reach Hermes".
        const message =
          error instanceof HermesError && error.code === 'hermes_timeout'
            ? 'Hermes is taking too long to respond. Try asking again in a moment.'
            : 'I could not reach Hermes just now.';

        logger.error('Hermes tool call failed', { callId, error });
        return reply.send({ callId, output: message, failed: true });
      }
    },
  );
}
