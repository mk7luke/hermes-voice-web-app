/**
 * Builds the xAI realtime `session` object.
 *
 * This is constructed server-side and handed to the browser as opaque config.
 * The browser could of course send its own `session.update` — it holds the
 * socket — but it gains nothing by doing so: the only tool exposed is
 * `ask_hermes`, and that tool executes on our server behind the cookie, not in
 * the page. The security boundary is the tool bridge, not this object.
 */

import type { Config } from './config.js';

/** PCM16 at 24 kHz — xAI's default and the best-supported browser path. */
export const AUDIO_SAMPLE_RATE = 24_000;

export type TurnMode = 'push_to_talk' | 'hands_free';

/**
 * The single bridge into Hermes.
 *
 * One tool, not a mirror of Hermes's toolset. Hermes owns tool dispatch; the
 * voice model only decides *when* to hand off, never *how* to act.
 */
const ASK_HERMES_TOOL = {
  type: 'function',
  name: 'ask_hermes',
  description:
    'Send a request to Hermes, the agent that holds all memory, tools, files and ' +
    'knowledge. Use this for any question or action beyond conversational filler. ' +
    'Pass the user\'s intent as a complete, self-contained sentence, including any ' +
    'context from earlier in the conversation that Hermes would need.',
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description:
          'The full request for Hermes, written as a standalone instruction or ' +
          'question. Resolve pronouns and references before sending.',
      },
    },
    required: ['request'],
  },
} as const;

export interface VoiceSessionOptions {
  turnMode: TurnMode;
}

export function buildVoiceSession(
  config: Config,
  { turnMode }: VoiceSessionOptions,
): Record<string, unknown> {
  return {
    voice: config.xaiVoice,
    instructions: config.voiceInstructions,

    // Push-to-talk drives turns explicitly with input_audio_buffer.commit, so
    // server VAD is disabled. Hands-free hands turn-taking to the server.
    turn_detection:
      turnMode === 'hands_free'
        ? {
            type: 'server_vad',
            threshold: 0.6,
            silence_duration_ms: 700,
            prefix_padding_ms: 300,
          }
        : null,

    audio: {
      input: {
        format: { type: 'audio/pcm', rate: AUDIO_SAMPLE_RATE },
        // Transcripts drive the on-screen conversation log.
        transcription: {},
      },
      output: {
        format: { type: 'audio/pcm', rate: AUDIO_SAMPLE_RATE },
      },
    },

    tools: [ASK_HERMES_TOOL],

    // Lets a dropped socket rejoin the same conversation instead of starting
    // over — the phone-on-a-train case.
    resumption: { enabled: true },
  };
}

export { ASK_HERMES_TOOL };
