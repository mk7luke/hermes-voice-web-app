/**
 * ElevenLabs Agents (Conversational AI) helpers.
 *
 * The browser never sees `ELEVENLABS_API_KEY`. It receives a short-lived
 * signed WebSocket URL, plus a `voice_id` override so custom / generated /
 * cloned voices work without baking one voice into the agent forever.
 */

import type { Logger } from './logger.js';

const SIGNED_URL_PATH = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';
const AGENTS_CREATE_URL = 'https://api.elevenlabs.io/v1/convai/agents/create';
const VOICES_URL = 'https://api.elevenlabs.io/v1/voices';

/** ConvAI PCM output. The PWA recreates AudioContext at this rate. */
export const ELEVENLABS_SAMPLE_RATE = 16_000;

export class ElevenLabsError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ElevenLabsError';
    this.status = status;
  }
}

export interface ElevenLabsVoice {
  readonly voiceId: string;
  readonly name: string;
  readonly category: string;
}

export interface SignedConversation {
  readonly signedUrl: string;
}

export interface ElevenLabsClientOptions {
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Pre-created agent. When omitted the client creates one and caches the id. */
  agentId?: string | null;
}

const ASK_HERMES_CLIENT_TOOL = {
  type: 'client',
  name: 'ask_hermes',
  description:
    'Send a request to Hermes, the agent that holds all memory, tools, files and ' +
    'knowledge. Use this for any question or action beyond conversational filler. ' +
    'Pass the user\'s intent as a complete, self-contained sentence, including any ' +
    'context from earlier in the conversation that Hermes would need.',
  expects_response: true,
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

export class ElevenLabsClient {
  readonly #apiKey: string;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #configuredAgentId: string | null;
  #createdAgentId: string | null = null;
  /** In-flight creation, so concurrent callers share one agent. */
  #creatingAgent: Promise<string> | null = null;

  constructor(options: ElevenLabsClientOptions) {
    this.#apiKey = options.apiKey;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#configuredAgentId = options.agentId?.trim() || null;
  }

  async createSignedUrl(agentId: string): Promise<SignedConversation> {
    const url = `${SIGNED_URL_PATH}?agent_id=${encodeURIComponent(agentId)}`;
    const body = await this.#requestJson<{ signed_url?: string }>(url, {
      method: 'GET',
    });
    if (!body.signed_url) {
      throw new ElevenLabsError('ElevenLabs returned no signed_url', 502);
    }
    return { signedUrl: body.signed_url };
  }

  async listVoices(): Promise<ElevenLabsVoice[]> {
    const body = await this.#requestJson<{ voices?: Array<Record<string, unknown>> }>(
      VOICES_URL,
      { method: 'GET' },
    );
    const voices = Array.isArray(body.voices) ? body.voices : [];
    return voices
      .map((voice) => {
        const voiceId = typeof voice.voice_id === 'string' ? voice.voice_id.trim() : '';
        const name = typeof voice.name === 'string' ? voice.name.trim() : voiceId;
        const category = typeof voice.category === 'string' ? voice.category : 'unknown';
        return { voiceId, name, category };
      })
      .filter((voice) => voice.voiceId.length > 0);
  }

  /**
   * Return a usable agent id. Prefer the configured one; otherwise create a
   * Hermes front-end agent once per process (with `ask_hermes` as a client tool).
   *
   * `defaultVoiceId` must be the stable `ELEVENLABS_VOICE_ID`, never whichever
   * voice happened to be picked first: the agent is created once and cached for
   * the life of the process, so binding it to a transient selection would leave
   * the wrong voice baked into its configuration. Per-session voices are applied
   * through `conversation_config_override`, which is why the agent is created
   * with `tts.voice_id` (and the prompt) explicitly marked overridable —
   * ElevenLabs disables every override by default and silently ignores the ones
   * an agent has not opted into.
   */
  async ensureAgent(defaultVoiceId: string, instructions: string): Promise<string> {
    if (this.#configuredAgentId) return this.#configuredAgentId;
    if (this.#createdAgentId) return this.#createdAgentId;

    // Single-flight. `#createdAgentId` is only set once the create request
    // resolves, so two sessions starting at the same moment would otherwise
    // both pass the check above and each leave a permanent agent behind on the
    // account. Cleared on settle so a failed attempt stays retryable.
    this.#creatingAgent ??= this.#createAgent(defaultVoiceId, instructions).finally(() => {
      this.#creatingAgent = null;
    });
    return this.#creatingAgent;
  }

  async #createAgent(defaultVoiceId: string, instructions: string): Promise<string> {
    const body = await this.#requestJson<{ agent_id?: string }>(AGENTS_CREATE_URL, {
      method: 'POST',
      payload: {
        name: 'Hermes Voice',
        conversation_config: {
          agent: {
            first_message: '',
            language: 'en',
            prompt: {
              prompt: instructions,
              temperature: 0.3,
              tools: [ASK_HERMES_CLIENT_TOOL],
            },
          },
          tts: {
            voice_id: defaultVoiceId,
            model_id: 'eleven_flash_v2_5',
            agent_output_audio_format: 'pcm_16000',
          },
          asr: { quality: 'high' },
          turn: {
            turn_timeout: 7,
            silence_end_call_timeout: -1,
          },
        },
        platform_settings: {
          overrides: {
            conversation_config_override: {
              agent: { prompt: { prompt: true } },
              tts: { voice_id: true },
            },
          },
        },
      },
    });

    const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
    if (!agentId) {
      throw new ElevenLabsError(
        'ElevenLabs created an agent without an id. Set ELEVENLABS_AGENT_ID.',
        502,
      );
    }
    this.#createdAgentId = agentId;
    this.#logger.info('created ElevenLabs agent for Hermes Voice', {
      agentIdPrefix: agentId.slice(0, 8),
    });
    return agentId;
  }

  async #requestJson<T>(
    url: string,
    init: { method: string; payload?: unknown },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: init.method,
        headers: {
          'xi-api-key': this.#apiKey,
          Accept: 'application/json',
          ...(init.payload ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.payload ? JSON.stringify(init.payload) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ElevenLabsError('ElevenLabs request timed out', 504);
      }
      throw new ElevenLabsError('Could not reach the ElevenLabs API', 502);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      this.#logger.error('ElevenLabs request failed', {
        status: response.status,
        urlHost: safeHost(url),
      });
      throw new ElevenLabsError(
        `ElevenLabs returned ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

export { ASK_HERMES_CLIENT_TOOL };
