/**
 * Voice session lifecycle.
 *
 * `POST /api/session/start` stitches the two halves together: a Hermes session
 * bound to this cookie, plus an ephemeral credential for the chosen voice
 * provider (xAI token or ElevenLabs signed URL). Long-lived keys stay here.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { VoiceProvider } from '../config.js';
import { VOICE_ID_RE } from '../config.js';
import type { AppContext } from '../context.js';
import { requireSession } from '../context.js';
import { ELEVENLABS_SAMPLE_RATE } from '../elevenlabs-client.js';
import {
  AUDIO_SAMPLE_RATE,
  buildElevenLabsInitiation,
  buildVoiceSession,
  type TurnMode,
} from '../voice-session.js';

const XAI_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

function resolveProvider(
  requested: string | undefined,
  fallback: VoiceProvider,
): VoiceProvider {
  if (requested === 'xai' || requested === 'elevenlabs') return requested;
  return fallback;
}

export function registerSessionRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, logger, hermes, xai, elevenlabs } = context;

  app.post(
    '/api/session/start',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            turnMode: { type: 'string', enum: ['push_to_talk', 'hands_free'] },
            provider: { type: 'string', enum: ['xai', 'elevenlabs'] },
            voiceId: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = requireSession(context, request, reply);
      if (!session) return reply;

      const body = (request.body ?? {}) as {
        turnMode?: TurnMode;
        provider?: VoiceProvider;
        voiceId?: string;
      };
      const turnMode: TurnMode = body.turnMode === 'hands_free' ? 'hands_free' : 'push_to_talk';
      const provider = resolveProvider(body.provider, config.defaultVoiceProvider);

      if (provider === 'xai' && !config.xaiEnabled) {
        return reply.code(400).send({
          error: 'provider_unavailable',
          message: 'xAI voice is not configured on this server.',
        });
      }
      if (provider === 'elevenlabs' && !config.elevenlabsEnabled) {
        return reply.code(400).send({
          error: 'provider_unavailable',
          message: 'ElevenLabs voice is not configured on this server.',
        });
      }

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

      if (provider === 'elevenlabs') {
        return startElevenLabs(reply, session, turnMode, body.voiceId);
      }
      return startXai(reply, session, turnMode);
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

  async function startXai(
    reply: FastifyReply,
    session: NonNullable<ReturnType<typeof requireSession>>,
    turnMode: TurnMode,
  ) {
    if (!xai) {
      return reply.code(503).send({
        error: 'xai_unavailable',
        message: 'xAI voice is not configured.',
      });
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

    return reply.send({
      provider: 'xai',
      token: token.value,
      expiresAt: token.expiresAt,
      realtimeUrl: XAI_REALTIME_URL,
      model: config.xaiVoiceModel,
      sampleRate: AUDIO_SAMPLE_RATE,
      turnMode,
      session: voiceSession,
      conversationId: session.conversationId,
      voiceId: config.xaiVoice,
      voiceName: config.xaiVoice,
    });
  }

  async function startElevenLabs(
    reply: FastifyReply,
    _session: NonNullable<ReturnType<typeof requireSession>>,
    turnMode: TurnMode,
    requestedVoiceId: string | undefined,
  ) {
    if (!elevenlabs || !config.elevenlabsVoiceId) {
      return reply.code(503).send({
        error: 'elevenlabs_unavailable',
        message: 'ElevenLabs voice is not configured.',
      });
    }

    const voiceId = resolveElevenLabsVoiceId(requestedVoiceId);
    if (!voiceId) {
      return reply.code(400).send({
        error: 'invalid_voice_id',
        message: 'That voice id is not allowed on this server.',
      });
    }

    let agentId: string;
    try {
      agentId = await elevenlabs.ensureAgent(voiceId, config.voiceInstructions);
    } catch (error) {
      logger.error('could not ensure an ElevenLabs agent', { error });
      return reply.code(503).send({
        error: 'elevenlabs_unavailable',
        message:
          'Could not prepare the ElevenLabs agent. Set ELEVENLABS_AGENT_ID or check the API key.',
      });
    }

    let signed;
    try {
      signed = await elevenlabs.createSignedUrl(agentId);
    } catch (error) {
      logger.error('could not mint an ElevenLabs signed URL', { error });
      return reply.code(503).send({
        error: 'elevenlabs_unavailable',
        message: 'Could not obtain a voice session from ElevenLabs.',
      });
    }

    const initiation = buildElevenLabsInitiation(config, voiceId);
    const voiceName =
      config.elevenlabsVoices.find((voice) => voice.id === voiceId)?.name ?? voiceId;

    return reply.send({
      provider: 'elevenlabs',
      signedUrl: signed.signedUrl,
      sampleRate: ELEVENLABS_SAMPLE_RATE,
      turnMode,
      voiceId,
      voiceName,
      initiation,
      conversationId: null,
    });
  }

  function resolveElevenLabsVoiceId(requested: string | undefined): string | null {
    const fallback = config.elevenlabsVoiceId;
    if (!fallback) return null;
    if (!requested || requested === fallback) return fallback;
    if (!VOICE_ID_RE.test(requested)) return null;
    if (config.elevenlabsVoices.some((voice) => voice.id === requested)) return requested;
    // No curated list: any well-formed id is accepted (the account still
    // has to own it; ElevenLabs will reject strangers).
    if (config.elevenlabsVoices.length === 0) return requested;
    return null;
  }
}
