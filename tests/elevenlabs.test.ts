import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../server/src/app.js';
import { SessionStore } from '../server/src/auth.js';
import { loadConfig, ConfigError } from '../server/src/config.js';
import type { AppContext } from '../server/src/context.js';
import { ElevenLabsClient } from '../server/src/elevenlabs-client.js';
import { HermesClient } from '../server/src/hermes-client.js';
import { createLogger } from '../server/src/logger.js';
import { XaiClient } from '../server/src/xai-client.js';
import { buildElevenLabsInitiation } from '../server/src/voice-session.js';

const silent = createLogger('error', () => {});

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    XAI_API_KEY: 'xai-test-key',
    API_SERVER_KEY: 'hermes-test-key',
    APP_PASSWORD: 'a-long-enough-password',
    SESSION_SECRET: 'x'.repeat(32),
    ...overrides,
  };
}

describe('ElevenLabs config', () => {
  it('allows ElevenLabs-only (no xAI key)', () => {
    const config = loadConfig(
      baseEnv({
        XAI_API_KEY: undefined,
        ELEVENLABS_API_KEY: 'el-key',
        ELEVENLABS_VOICE_ID: '9GJrVnm8x3V1ySKEZC8v',
      }),
    );
    expect(config.elevenlabsEnabled).toBe(true);
    expect(config.xaiEnabled).toBe(false);
    expect(config.defaultVoiceProvider).toBe('elevenlabs');
    expect(config.elevenlabsVoiceId).toBe('9GJrVnm8x3V1ySKEZC8v');
  });

  it('keeps xAI as the default when both providers are configured', () => {
    const config = loadConfig(
      baseEnv({
        ELEVENLABS_API_KEY: 'el-key',
        ELEVENLABS_VOICE_ID: '9GJrVnm8x3V1ySKEZC8v',
      }),
    );
    expect(config.defaultVoiceProvider).toBe('xai');
    expect(config.elevenlabsEnabled).toBe(true);
  });

  it('honours VOICE_PROVIDER=elevenlabs when both keys exist', () => {
    const config = loadConfig(
      baseEnv({
        ELEVENLABS_API_KEY: 'el-key',
        ELEVENLABS_VOICE_ID: '9GJrVnm8x3V1ySKEZC8v',
        VOICE_PROVIDER: 'elevenlabs',
      }),
    );
    expect(config.defaultVoiceProvider).toBe('elevenlabs');
  });

  it('rejects an ElevenLabs key without a voice id', () => {
    expect(() =>
      loadConfig(baseEnv({ ELEVENLABS_API_KEY: 'el-key' })),
    ).toThrow(/ELEVENLABS_VOICE_ID/);
  });

  it('rejects a malformed voice id', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          ELEVENLABS_API_KEY: 'el-key',
          ELEVENLABS_VOICE_ID: 'bad id!',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('parses a curated ELEVENLABS_VOICES list', () => {
    const config = loadConfig(
      baseEnv({
        ELEVENLABS_API_KEY: 'el-key',
        ELEVENLABS_VOICE_ID: '9GJrVnm8x3V1ySKEZC8v',
        ELEVENLABS_VOICES: 'B2 Billy:9GJrVnm8x3V1ySKEZC8v,B3 Blacco:Ur4YgPmZBxyEyA0H5yP5',
      }),
    );
    expect(config.elevenlabsVoices).toEqual([
      { id: '9GJrVnm8x3V1ySKEZC8v', name: 'B2 Billy' },
      { id: 'Ur4YgPmZBxyEyA0H5yP5', name: 'B3 Blacco' },
    ]);
  });
});

describe('ElevenLabsClient', () => {
  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Routes the calls the lazy-agent flow makes: list tools, register the
   * ask_hermes client tool, create the agent.
   */
  function convaiFetch(
    options: {
      existingTools?: Array<Record<string, unknown>>;
      gate?: Promise<void>;
      failAgentTimes?: number;
    } = {},
  ) {
    const calls = {
      listTools: 0,
      createTool: 0,
      createAgent: 0,
      toolPayloads: [] as Array<Record<string, unknown>>,
      agentPayloads: [] as Array<Record<string, unknown>>,
    };
    let agentFailuresLeft = options.failAgentTimes ?? 0;

    const impl = vi.fn(async (url: string, init: RequestInit) => {
      if (options.gate) await options.gate;
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};

      if (url.endsWith('/convai/tools')) {
        if (init.method === 'GET') {
          calls.listTools += 1;
          return json({ tools: options.existingTools ?? [] });
        }
        calls.createTool += 1;
        calls.toolPayloads.push(body);
        return json({ id: 'tool_ask_hermes' });
      }

      calls.createAgent += 1;
      calls.agentPayloads.push(body);
      if (agentFailuresLeft > 0) {
        agentFailuresLeft -= 1;
        return new Response('nope', { status: 500 });
      }
      return json({ agent_id: 'agt_created' });
    });

    return { impl: impl as unknown as typeof fetch, spy: impl, calls };
  }

  function client(fetchImpl: typeof fetch, agentId?: string) {
    return new ElevenLabsClient({
      apiKey: 'el-secret-key',
      logger: silent,
      fetchImpl,
      ...(agentId ? { agentId } : {}),
    });
  }

  it('mints a signed URL without leaking the API key into the result', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        signed_url:
          'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agt_1&token=ephem',
      }),
    );
    const el = client(fetchImpl as unknown as typeof fetch, 'agt_1');

    const signed = await el.createSignedUrl('agt_1');
    expect(signed.signedUrl).toContain('token=ephem');
    expect(JSON.stringify(signed)).not.toContain('el-secret-key');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('agent_id=agt_1');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('el-secret-key');
  });

  it('creates an agent once when none is configured', async () => {
    const { impl, calls } = convaiFetch();
    const el = client(impl);

    await expect(el.ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.')).resolves.toBe(
      'agt_created',
    );
    await expect(el.ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.')).resolves.toBe(
      'agt_created',
    );
    expect(calls.createAgent).toBe(1);
  });

  it('references ask_hermes by tool id, never inline', async () => {
    // ElevenLabs has rejected any create request containing `prompt.tools`
    // since 2025-07-23. Inlining the tool means the agent never gets created.
    const { impl, calls } = convaiFetch();
    await client(impl).ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.');

    const config = calls.agentPayloads[0]!.conversation_config as {
      agent: { prompt: Record<string, unknown> };
    };
    expect(config.agent.prompt.tool_ids).toEqual(['tool_ask_hermes']);
    expect(config.agent.prompt.tools).toBeUndefined();

    const tool = calls.toolPayloads[0]!.tool_config as Record<string, unknown>;
    expect(tool.type).toBe('client');
    expect(tool.name).toBe('ask_hermes');
    expect(tool.expects_response).toBe(true);
    // Must not abandon a request Hermes is still working on: HERMES_TIMEOUT_MS
    // defaults to 120s, which is also the ElevenLabs maximum.
    expect(tool.response_timeout_secs).toBe(120);
  });

  it('pairs the English agent with an English-only TTS model', async () => {
    // ElevenLabs rejects language:'en' alongside a multilingual model with
    // "English Agents must use turbo or flash v2", failing agent creation
    // outright — so the two fields have to move together.
    const { impl, calls } = convaiFetch();
    await client(impl).ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.');

    const config = calls.agentPayloads[0]!.conversation_config as {
      agent: { language: string };
      tts: { model_id: string };
    };
    expect(config.agent.language).toBe('en');
    expect(['eleven_flash_v2', 'eleven_turbo_v2']).toContain(config.tts.model_id);
  });

  it('reuses an existing ask_hermes tool instead of piling up duplicates', async () => {
    const { impl, calls } = convaiFetch({
      existingTools: [
        { id: 'tool_other', tool_config: { name: 'something_else' } },
        { id: 'tool_existing', tool_config: { name: 'ask_hermes' } },
      ],
    });
    await client(impl).ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.');

    expect(calls.createTool).toBe(0);
    const config = calls.agentPayloads[0]!.conversation_config as {
      agent: { prompt: { tool_ids: string[] } };
    };
    expect(config.agent.prompt.tool_ids).toEqual(['tool_existing']);
  });

  it('creates one agent when two sessions start at the same moment', async () => {
    // #createdAgentId is only set after the request resolves, so without
    // single-flight both callers pass the cache check and each leaves a
    // permanent agent behind on the account.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { impl, calls } = convaiFetch({ gate });
    const el = client(impl);

    const both = Promise.all([
      el.ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.'),
      el.ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.'),
    ]);
    release!();

    expect(await both).toEqual(['agt_created', 'agt_created']);
    expect(calls.createAgent).toBe(1);
    expect(calls.createTool).toBe(1);
  });

  it('retries agent creation after a failure', async () => {
    // A failed attempt must not latch: the in-flight promise is cleared on
    // settle, so the next session can try again.
    const { impl, calls } = convaiFetch({ failAgentTimes: 1 });
    const el = client(impl);

    await expect(el.ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.')).rejects.toThrow();
    await expect(el.ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.')).resolves.toBe(
      'agt_created',
    );
    expect(calls.createAgent).toBe(2);
  });

  it('carries the upstream validation detail into the error', async () => {
    // A bare "ElevenLabs returned 400" says nothing about which field was
    // rejected, which is the only thing that makes a 400 actionable.
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          detail: [
            { loc: ['body', 'conversation_config', 'tts'], msg: 'unexpected field' },
          ],
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      client(fetchImpl as unknown as typeof fetch).listVoices(),
    ).rejects.toThrow(/body\.conversation_config\.tts: unexpected field/);
  });

  it('falls back to raw text when the error body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream exploded', { status: 502 }));

    await expect(
      client(fetchImpl as unknown as typeof fetch).listVoices(),
    ).rejects.toThrow(/upstream exploded/);
  });

  it('creates the agent with voice and prompt overrides enabled', async () => {
    const { impl, calls } = convaiFetch();
    await client(impl).ensureAgent('9GJrVnm8x3V1ySKEZC8v', 'Be brief.');

    const payload = calls.agentPayloads[0]! as {
      conversation_config: { tts: { voice_id: string } };
      platform_settings: {
        overrides: {
          conversation_config_override: {
            agent: { prompt: { prompt: boolean } };
            tts: { voice_id: boolean };
          };
        };
      };
    };
    // ElevenLabs ignores every override an agent has not opted into, so the
    // per-session voice only works if these flags are set at creation.
    const overrides = payload.platform_settings.overrides.conversation_config_override;
    expect(overrides.tts.voice_id).toBe(true);
    expect(overrides.agent.prompt.prompt).toBe(true);
    expect(payload.conversation_config.tts.voice_id).toBe('9GJrVnm8x3V1ySKEZC8v');
  });
});

describe('buildElevenLabsInitiation', () => {
  it('overrides tts.voice_id so custom voices apply per session', () => {
    const config = loadConfig(
      baseEnv({
        ELEVENLABS_API_KEY: 'el-key',
        ELEVENLABS_VOICE_ID: '9GJrVnm8x3V1ySKEZC8v',
      }),
    );
    const init = buildElevenLabsInitiation(config, 'Ur4YgPmZBxyEyA0H5yP5');
    const override = init.conversation_config_override as {
      tts: { voice_id: string };
    };
    expect(override.tts.voice_id).toBe('Ur4YgPmZBxyEyA0H5yP5');
  });
});

describe('session start with ElevenLabs', () => {
  const PASSWORD = 'correct-horse-battery';
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function startApp(
    options: { voices?: string; agentVoices?: string[]; elevenLabsOnly?: boolean } = {},
  ) {
    const config = loadConfig({
      ...(options.elevenLabsOnly ? {} : { XAI_API_KEY: 'xai-test' }),
      ELEVENLABS_API_KEY: 'el-test',
      ELEVENLABS_VOICE_ID: '9GJrVnm8x3V1ySKEZC8v',
      ELEVENLABS_VOICES:
        options.voices ??
        'B2 Billy:9GJrVnm8x3V1ySKEZC8v,B3 Blacco:Ur4YgPmZBxyEyA0H5yP5',
      API_SERVER_KEY: 'hermes-test',
      APP_PASSWORD: PASSWORD,
      SESSION_SECRET: 'y'.repeat(40),
      COOKIE_SECURE: 'false',
      LOG_LEVEL: 'error',
    });
    const logger = createLogger('error', () => {});
    const hermes = new HermesClient({
      baseUrl: config.hermesApiUrl,
      apiKey: config.hermesApiKey,
      sessionKey: null,
      timeoutMs: 1_000,
      logger,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    hermes.createSession = (async () => 'api_session_el') as HermesClient['createSession'];
    hermes.health = (async () => true) as HermesClient['health'];

    const xai = new XaiClient({
      apiKey: 'xai-test',
      logger,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    xai.createEphemeralToken = (async () => ({
      value: 'ephemeral-token',
      expiresAt: 9_999_999,
    })) as XaiClient['createEphemeralToken'];

    const elevenlabs = new ElevenLabsClient({
      apiKey: 'el-test',
      logger,
      agentId: options.agentVoices ? null : 'agt_fixed',
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    if (options.agentVoices) {
      const seen = options.agentVoices;
      elevenlabs.ensureAgent = (async (voiceId: string) => {
        seen.push(voiceId);
        return 'agt_created';
      }) as ElevenLabsClient['ensureAgent'];
    }
    elevenlabs.createSignedUrl = (async () => ({
      signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agt_fixed&token=el-ephem',
    })) as ElevenLabsClient['createSignedUrl'];

    const context: AppContext = {
      config,
      logger,
      sessions: new SessionStore(config.sessionTtlMs),
      hermes,
      xai: options.elevenLabsOnly ? null : xai,
      elevenlabs,
      passwordSalt: 'test-salt',
    };
    app = await buildApp(context);
    return app;
  }

  async function login(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: PASSWORD },
    });
    const cookie = response.cookies[0];
    if (!cookie) throw new Error('no cookie');
    return `${cookie.name}=${cookie.value}`;
  }

  it('returns a signed URL and the requested custom voice id, never the API key', async () => {
    await startApp();
    const cookie = await login();
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: {
        turnMode: 'push_to_talk',
        provider: 'elevenlabs',
        voiceId: 'Ur4YgPmZBxyEyA0H5yP5',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      provider: string;
      signedUrl: string;
      voiceId: string;
      sampleRate: number;
      initiation: { conversation_config_override: { tts: { voice_id: string } } };
    };
    expect(body.provider).toBe('elevenlabs');
    expect(body.signedUrl).toContain('token=el-ephem');
    expect(body.voiceId).toBe('Ur4YgPmZBxyEyA0H5yP5');
    expect(body.sampleRate).toBe(16_000);
    expect(body.initiation.conversation_config_override.tts.voice_id).toBe(
      'Ur4YgPmZBxyEyA0H5yP5',
    );
    expect(response.body).not.toContain('el-test');
    expect(response.body).not.toContain('xai-test');
  });

  it('rejects a voice id outside the curated allowlist', async () => {
    await startApp();
    const cookie = await login();
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: { provider: 'elevenlabs', voiceId: 'pNInz6obpgDQGcFmaJgB' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_voice_id');
  });

  it('accepts the configured default voice even when the curated list omits it', async () => {
    await startApp({ voices: 'B3 Blacco:Ur4YgPmZBxyEyA0H5yP5' });
    const cookie = await login();
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: { provider: 'elevenlabs', voiceId: '9GJrVnm8x3V1ySKEZC8v' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { voiceId: string }).voiceId).toBe('9GJrVnm8x3V1ySKEZC8v');
  });

  it('creates the lazy agent from the configured voice, whichever voice is picked first', async () => {
    const agentVoices: string[] = [];
    await startApp({ agentVoices });
    const cookie = await login();

    for (const voiceId of ['Ur4YgPmZBxyEyA0H5yP5', '9GJrVnm8x3V1ySKEZC8v']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/session/start',
        headers: { cookie },
        payload: { provider: 'elevenlabs', voiceId },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { voiceId: string }).voiceId).toBe(voiceId);
    }

    // Never the transient selection: the cached agent must not inherit whichever
    // voice happened to be picked first.
    expect(agentVoices).toEqual(['9GJrVnm8x3V1ySKEZC8v', '9GJrVnm8x3V1ySKEZC8v']);
  });

  it('falls back to the server default when the client names no provider', async () => {
    // The PWA sends no provider until /api/voice/options resolves, so an
    // ElevenLabs-only server must not be handed a hardcoded xAI guess.
    await startApp({ elevenLabsOnly: true });
    const cookie = await login();
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/start',
      headers: { cookie },
      payload: { turnMode: 'push_to_talk' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { provider: string; voiceId: string };
    expect(body.provider).toBe('elevenlabs');
    expect(body.voiceId).toBe('9GJrVnm8x3V1ySKEZC8v');
  });

  it('lists both providers for the picker', async () => {
    await startApp();
    const cookie = await login();
    const response = await app.inject({
      method: 'GET',
      url: '/api/voice/options',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { providers: Array<{ id: string }> };
    expect(body.providers.map((provider) => provider.id)).toEqual(['xai', 'elevenlabs']);
  });
});
