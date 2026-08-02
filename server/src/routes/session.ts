/**
 * Voice session lifecycle.
 *
 * `POST /api/session/start` is where the two halves of the architecture are
 * stitched together: a Hermes session is created (or reused) and bound to this
 * browser's cookie, and an xAI ephemeral token is minted for the audio leg.
 */

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { requireSession } from '../context.js';
import { AUDIO_SAMPLE_RATE, buildVoiceSession, type TurnMode } from '../voice-session.js';

const XAI_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

export function registerSessionRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, logger, hermes, xai } = context;

  app.post(
    '/api/session/start',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            turnMode: { type: 'string', enum: ['push_to_talk', 'hands_free'] },
          },
        },
      },
    },
    async (request, reply) => {
      const session = requireSession(context, request, reply);
      if (!session) return reply;

      const body = (request.body ?? {}) as { turnMode?: TurnMode };
      const turnMode: TurnMode = body.turnMode === 'hands_free' ? 'hands_free' : 'push_to_talk';

      // Reuse the Hermes session across reconnects so conversation context and
      // memory survive a dropped socket. A fresh one is only created when this
      // browser session has never had one.
      if (!session.hermesSessionId) {
        try {
          session.hermesSessionId = await hermes.createSession(
            `Voice ${new Date().toISOString()}`,
          );
        } catch (error) {
          logger.error('could not create a Hermes session', { error });
          return reply.code(503).send({
            error: 'hermes_unavailable',
            message: 'Hermes is not reachable. Check that the agent is running.',
          });
        }
      }

      const voiceSession = buildVoiceSession(config, { turnMode });

      let token;
      try {
        token = await xai.createEphemeralToken(config.xaiTokenTtlSeconds, {
          model: config.xaiVoiceModel,
          ...voiceSession,
        });
      } catch (error) {
        logger.error('could not mint an xAI ephemeral token', { error });
        return reply.code(503).send({
          error: 'xai_unavailable',
          message: 'Could not obtain a voice token from xAI.',
        });
      }

      // The response deliberately contains no long-lived secret: only the
      // ephemeral token, which expires on its own.
      return reply.send({
        token: token.value,
        expiresAt: token.expiresAt,
        realtimeUrl: XAI_REALTIME_URL,
        model: config.xaiVoiceModel,
        sampleRate: AUDIO_SAMPLE_RATE,
        turnMode,
        session: voiceSession,
        conversationId: session.conversationId,
      });
    },
  );

  /**
   * Record the xAI conversation id so a reconnect can resume rather than
   * restart. Best-effort: failure here costs continuity, not correctness.
   */
  app.post(
    '/api/session/conversation',
    {
      schema: {
        body: {
          type: 'object',
          required: ['conversationId'],
          properties: {
            conversationId: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = requireSession(context, request, reply);
      if (!session) return reply;

      const { conversationId } = request.body as { conversationId: string };
      session.conversationId = conversationId;
      return reply.send({ ok: true });
    },
  );

  /**
   * End the voice conversation.
   *
   * Clears the Hermes binding and the resumption id so the next start begins a
   * genuinely fresh conversation. The login itself survives — ending a chat
   * should not log you out.
   */
  app.post('/api/session/end', async (request, reply) => {
    const session = requireSession(context, request, reply);
    if (!session) return reply;

    logger.info('voice session ended', {
      sessionId: session.id.slice(0, 8),
      hadConversation: session.conversationId !== null,
    });

    session.hermesSessionId = null;
    session.conversationId = null;
    return reply.send({ ok: true });
  });
}
