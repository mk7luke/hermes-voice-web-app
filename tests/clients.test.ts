import { describe, expect, it, vi } from 'vitest';

import { HermesClient, HermesError } from '../server/src/hermes-client.js';
import { createLogger, redact } from '../server/src/logger.js';
import { XaiClient } from '../server/src/xai-client.js';

const silentLogger = createLogger('error', () => {});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hermesClient(fetchImpl: typeof fetch, timeoutMs = 5_000): HermesClient {
  return new HermesClient({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'secret-hermes-key',
    sessionKey: null,
    timeoutMs,
    logger: silentLogger,
    fetchImpl,
  });
}

describe('HermesClient', () => {
  it('creates a session and returns its id', async () => {
    // api_server responds with the row wrapped in `session`, status 201.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ object: 'hermes.session', session: { id: 'api_123' } }, 201),
    );
    const client = hermesClient(fetchImpl as unknown as typeof fetch);

    await expect(client.createSession('Voice test')).resolves.toBe('api_123');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8642/api/sessions');
    expect(init.method).toBe('POST');
  });

  it('accepts a flat session id from older gateways', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'api_flat' }));
    const client = hermesClient(fetchImpl as unknown as typeof fetch);

    await expect(client.createSession('Voice test')).resolves.toBe('api_flat');
  });

  it('sends the bearer key Hermes expects', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'api_1' }));
    await hermesClient(fetchImpl as unknown as typeof fetch).createSession('t');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-hermes-key');
  });

  it('includes the memory-scoping header only when configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'api_1' }));
    const scoped = new HermesClient({
      baseUrl: 'http://127.0.0.1:8642',
      apiKey: 'k',
      sessionKey: 'voice-scope',
      timeoutMs: 5_000,
      logger: silentLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await scoped.createSession('t');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Hermes-Session-Key']).toBe(
      'voice-scope',
    );
  });

  it('posts chat to the session-scoped path with a message field', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: { role: 'assistant', content: 'Hello there.' } }),
    );
    const client = hermesClient(fetchImpl as unknown as typeof fetch);

    await expect(client.chat('api_123', 'What is the weather?')).resolves.toBe(
      'Hello there.',
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8642/api/sessions/api_123/chat');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'What is the weather?' });
  });

  it('url-encodes the session id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: { content: 'ok' } }));
    await hermesClient(fetchImpl as unknown as typeof fetch).chat('a b/c', 'hi');

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://127.0.0.1:8642/api/sessions/a%20b%2Fc/chat');
  });

  it('flattens multimodal content parts into speakable text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Part one.' }, { type: 'text', text: 'Part two.' }],
        },
      }),
    );

    await expect(
      hermesClient(fetchImpl as unknown as typeof fetch).chat('s', 'hi'),
    ).resolves.toBe('Part one.\nPart two.');
  });

  it('returns a spoken fallback when Hermes replies with nothing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: { content: '' } }));
    const reply = await hermesClient(fetchImpl as unknown as typeof fetch).chat('s', 'hi');
    expect(reply).toMatch(/no spoken response/i);
  });

  it('surfaces the error message Hermes returns', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'Session not found' } }, 404),
    );

    await expect(
      hermesClient(fetchImpl as unknown as typeof fetch).chat('missing', 'hi'),
    ).rejects.toThrow('Session not found');
  });

  it('reports an unreachable Hermes as a 502 rather than leaking the cause', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });

    await expect(
      hermesClient(fetchImpl as unknown as typeof fetch).chat('s', 'hi'),
    ).rejects.toMatchObject({ status: 502, code: 'hermes_unreachable' });
  });

  it('times out a slow Hermes turn with a distinguishable code', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      // Mimic fetch's abort behaviour so the timeout path is genuinely tested.
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    await expect(
      hermesClient(fetchImpl as unknown as typeof fetch, 20).chat('s', 'hi'),
    ).rejects.toMatchObject({ code: 'hermes_timeout' });
  });

  it('reports health as false instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    await expect(hermesClient(fetchImpl as unknown as typeof fetch).health()).resolves.toBe(
      false,
    );
  });
});

describe('XaiClient', () => {
  it('requests an ephemeral token with the documented payload shape', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ value: 'ephemeral-abc', expires_at: 1893456000 }),
    );
    const client = new XaiClient({
      apiKey: 'xai-long-lived-key',
      logger: silentLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const token = await client.createEphemeralToken(600, { model: 'grok-voice-latest' });

    expect(token).toEqual({ value: 'ephemeral-abc', expiresAt: 1893456000 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/realtime/client_secrets');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer xai-long-lived-key',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      expires_after: { seconds: 600 },
      session: { model: 'grok-voice-latest' },
    });
  });

  it('derives an expiry when xAI omits one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 'ephemeral-abc' }));
    const client = new XaiClient({
      apiKey: 'k',
      logger: silentLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const before = Math.floor(Date.now() / 1000);
    const token = await client.createEphemeralToken(600, {});
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 600);
  });

  it('fails loudly when xAI rejects the request', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'invalid api key' } }, 401),
    );
    const client = new XaiClient({
      apiKey: 'bad',
      logger: silentLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.createEphemeralToken(600, {})).rejects.toThrow('invalid api key');
  });

  it('rejects a token response with no value', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ expires_at: 1 }));
    const client = new XaiClient({
      apiKey: 'k',
      logger: silentLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.createEphemeralToken(600, {})).rejects.toThrow(/without a value/);
  });
});

describe('log redaction', () => {
  it('redacts values under sensitive key names', () => {
    expect(
      redact({ password: 'hunter2000', token: 'abc', authorization: 'Bearer x' }),
    ).toEqual({ password: '[redacted]', token: '[redacted]', authorization: '[redacted]' });
  });

  it('redacts key-shaped values even under innocent key names', () => {
    const output = redact({ note: 'the key is xai-abcdef123456 ok' }) as { note: string };
    expect(output.note).not.toContain('xai-abcdef123456');
    expect(output.note).toContain('[redacted]');
  });

  it('redacts bearer tokens inside free text', () => {
    const output = redact('sent Bearer abc123def456 upstream') as string;
    expect(output).not.toContain('abc123def456');
  });

  it('recurses into nested structures', () => {
    expect(redact({ outer: { inner: { api_key: 'sk-live-1' } } })).toEqual({
      outer: { inner: { api_key: '[redacted]' } },
    });
  });

  it('keeps ordinary values intact', () => {
    expect(redact({ sessionId: 'api_123', count: 3, ok: true })).toEqual({
      sessionId: 'api_123',
      count: 3,
      ok: true,
    });
  });

  it('never emits a secret through the logger itself', () => {
    const lines: string[] = [];
    const logger = createLogger('info', (line) => lines.push(line));

    logger.info('minted token', { token: 'ephemeral-secret-value' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('ephemeral-secret-value');
    expect(lines[0]).toContain('[redacted]');
  });

  it('terminates on deeply nested input rather than overflowing', () => {
    let nested: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 50; i += 1) nested = { nested };
    expect(() => redact(nested)).not.toThrow();
  });
});
