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
const TOOLS_URL = 'https://api.elevenlabs.io/v1/convai/tools';
const VOICES_URL = 'https://api.elevenlabs.io/v1/voices';

/**
 * Hermes' own timeout is 120s (HERMES_TIMEOUT_MS), and 120 is also the maximum
 * ElevenLabs accepts. `ask_hermes` blocks the conversation while it runs, so the
 * two need to agree — a shorter value here would abandon a request Hermes is
 * still working on.
 */
const ASK_HERMES_TIMEOUT_SECONDS = 120;

/** ConvAI PCM output. The PWA recreates AudioContext at this rate. */
export const ELEVENLABS_SAMPLE_RATE = 16_000;

export class ElevenLabsError extends Error {
  readonly status: number;
  /** Upstream validation text, when ElevenLabs sent any. */
  readonly detail: string | null;

  constructor(message: string, status: number, detail: string | null = null) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = 'ElevenLabsError';
    this.status = status;
    this.detail = detail;
  }
}

/** Longest upstream message worth carrying into a log line or a banner. */
const MAX_DETAIL_LENGTH = 400;

/**
 * Pull the human-readable part out of an ElevenLabs error response.
 *
 * Their validation errors arrive as `{"detail": [{"loc": [...], "msg": "..."}]}`
 * or `{"detail": {"message": "..."}}` depending on the endpoint, so this walks
 * the common shapes and falls back to raw text.
 */
async function readErrorDetail(response: Response): Promise<string | null> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.slice(0, MAX_DETAIL_LENGTH);
  }

  const detail = (parsed as { detail?: unknown })?.detail ?? parsed;

  if (Array.isArray(detail)) {
    const parts = detail.map((entry) => {
      const item = entry as { loc?: unknown; msg?: unknown };
      const where = Array.isArray(item.loc) ? item.loc.join('.') : '';
      const what = typeof item.msg === 'string' ? item.msg : JSON.stringify(entry);
      return where ? `${where}: ${what}` : what;
    });
    return parts.join('; ').slice(0, MAX_DETAIL_LENGTH);
  }

  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string') return message.slice(0, MAX_DETAIL_LENGTH);
    return JSON.stringify(detail).slice(0, MAX_DETAIL_LENGTH);
  }

  return String(detail).slice(0, MAX_DETAIL_LENGTH);
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

/**
 * Registered through `POST /v1/convai/tools` and referenced by id, not inlined
 * into the agent. ElevenLabs deprecated `prompt.tools` and has rejected any
 * request containing it since 2025-07-23; an agent built that way fails to
 * create at all.
 */
const ASK_HERMES_CLIENT_TOOL = {
  type: 'client',
  name: 'ask_hermes',
  response_timeout_secs: ASK_HERMES_TIMEOUT_SECONDS,
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
      label: 'signed-url',
    });
    if (!body.signed_url) {
      throw new ElevenLabsError('ElevenLabs returned no signed_url', 502);
    }
    return { signedUrl: body.signed_url };
  }

  async listVoices(): Promise<ElevenLabsVoice[]> {
    const body = await this.#requestJson<{ voices?: Array<Record<string, unknown>> }>(
      VOICES_URL,
      { method: 'GET', label: 'list-voices' },
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

  /**
   * Return the id of the workspace's `ask_hermes` client tool, registering it
   * if this account does not have one yet.
   *
   * Existing tools are reused by name so a process restart — or a second
   * deployment against the same account — does not pile up duplicates.
   */
  async #ensureAskHermesTool(): Promise<string> {
    const listed = await this.#requestJson<{ tools?: Array<Record<string, unknown>> }>(
      TOOLS_URL,
      { method: 'GET', label: 'list-tools' },
    );
    for (const tool of Array.isArray(listed.tools) ? listed.tools : []) {
      const config = tool.tool_config as { name?: unknown } | undefined;
      const name = typeof config?.name === 'string' ? config.name : tool.name;
      if (name !== ASK_HERMES_CLIENT_TOOL.name) continue;
      const id = toolId(tool);
      if (id) return id;
    }

    const created = await this.#requestJson<Record<string, unknown>>(TOOLS_URL, {
      method: 'POST',
      label: 'create-tool',
      payload: { tool_config: ASK_HERMES_CLIENT_TOOL },
    });
    const id = toolId(created);
    if (!id) {
      throw new ElevenLabsError('ElevenLabs created a tool without an id', 502);
    }
    this.#logger.info('registered the ask_hermes client tool', {
      toolIdPrefix: id.slice(0, 8),
    });
    return id;
  }

  async #createAgent(defaultVoiceId: string, instructions: string): Promise<string> {
    const askHermesToolId = await this.#ensureAskHermesTool();

    const body = await this.#requestJson<{ agent_id?: string }>(AGENTS_CREATE_URL, {
      method: 'POST',
      label: 'create-agent',
      payload: {
        name: 'Hermes Voice',
        conversation_config: {
          agent: {
            first_message: '',
            language: 'en',
            prompt: {
              prompt: instructions,
              temperature: 0.3,
              tool_ids: [askHermesToolId],
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
    init: { method: string; payload?: unknown; label?: string },
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
      // A bare status is not diagnosable: a 400 from agent creation means one
      // named field was rejected, and only the body says which. It is
      // ElevenLabs' own validation text, not ours, and every log line still
      // goes through `redact()`.
      const detail = await readErrorDetail(response);
      this.#logger.error('ElevenLabs request failed', {
        request: init.label ?? init.method,
        status: response.status,
        urlHost: safeHost(url),
        detail,
      });
      throw new ElevenLabsError(
        `ElevenLabs returned ${response.status}`,
        response.status,
        detail,
      );
    }

    return (await response.json()) as T;
  }
}

/** Tool endpoints have returned the id as both `id` and `tool_id`. */
function toolId(tool: Record<string, unknown>): string | null {
  for (const key of ['id', 'tool_id'] as const) {
    const value = tool[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

export { ASK_HERMES_CLIENT_TOOL };
