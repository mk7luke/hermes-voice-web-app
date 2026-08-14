/**
 * Voice catalogue for the picker UI.
 *
 * Authenticated, no secrets. Lists whichever providers this server can
 * actually start a session with, plus the voice ids the operator configured
 * (or the live ElevenLabs account catalogue).
 */

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { requireSession } from '../context.js';

export function registerVoiceRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, elevenlabs, logger } = context;

  app.get('/api/voice/options', async (request, reply) => {
    const session = requireSession(context, request, reply);
    if (!session) return reply;

    const providers: Array<{
      id: 'xai' | 'elevenlabs';
      label: string;
      voices: Array<{ id: string; name: string }>;
    }> = [];

    if (config.xaiEnabled) {
      providers.push({
        id: 'xai',
        label: 'xAI',
        voices: [{ id: config.xaiVoice, name: config.xaiVoice }],
      });
    }

    if (config.elevenlabsEnabled && config.elevenlabsVoiceId) {
      let voices = config.elevenlabsVoices.map((voice) => ({
        id: voice.id,
        name: voice.name,
      }));

      if (voices.length === 0 && elevenlabs) {
        try {
          const listed = await elevenlabs.listVoices();
          voices = listed.map((voice) => ({ id: voice.voiceId, name: voice.name }));
        } catch (error) {
          logger.warn('could not list ElevenLabs voices; falling back to default id', {
            error,
          });
        }
      }

      if (!voices.some((voice) => voice.id === config.elevenlabsVoiceId)) {
        voices.unshift({
          id: config.elevenlabsVoiceId,
          name: config.elevenlabsVoiceId,
        });
      }

      providers.push({
        id: 'elevenlabs',
        label: 'ElevenLabs',
        voices,
      });
    }

    return reply.send({
      defaultProvider: config.defaultVoiceProvider,
      defaultVoiceId:
        config.defaultVoiceProvider === 'elevenlabs'
          ? config.elevenlabsVoiceId
          : config.xaiVoice,
      providers,
    });
  });
}
