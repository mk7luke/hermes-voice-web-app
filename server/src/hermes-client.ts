/**
 * Client for the Hermes `api_server` gateway platform.
 *
 * Contract confirmed against hermes-agent `gateway/platforms/api_server.py`:
 *   POST /api/sessions              -> { id?, title?, system_prompt?, model? }
 *   POST /api/sessions/{id}/chat    -> { message } => { message: { role, content } }
 *   GET  /health
 *
 * Auth is `Authorization: Bearer $API_SERVER_KEY`. That key never leaves this
 * process.
 */

import type { Logger } from './logger.js';

export class HermesError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = 'hermes_error') {
    super(message);
    this.name = 'HermesError';
    this.status = status;
    this.code = code;
  }
}

interface HermesChatResponse {
  message?: { role?: string; content?: unknown };
  session_id?: string;
  usage?: Record<string, unknown>;
}

/**
 * Hermes returns assistant content as a string in the common case, but the
 * multimodal normaliser can hand back a content-part array. Flatten to the text
 * we can actually speak.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

export interface HermesClientOptions {
  baseUrl: string;
  apiKey: string;
  sessionKey?: string | null;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class HermesClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #sessionKey: string | null;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;

  constructor(options: HermesClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#sessionKey = options.sessionKey ?? null;
    this.#timeoutMs = options.timeoutMs;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.#sessionKey) {
      headers['X-Hermes-Session-Key'] = this.#sessionKey;
    }
    return headers;
  }

  async #request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: this.#headers(),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HermesError(
          `Hermes did not respond within ${timeoutMs}ms`,
          504,
          'hermes_timeout',
        );
      }
      throw new HermesError(
        `Could not reach Hermes at ${this.#baseUrl}`,
        502,
        'hermes_unreachable',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Surface Hermes's own error code when it sends one; the body is small
      // and non-secret (it is an error envelope, not conversation content).
      let detail = '';
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        /* non-JSON error body; the status alone will have to do */
      }
      throw new HermesError(
        detail || `Hermes returned ${response.status}`,
        response.status,
        'hermes_request_failed',
      );
    }

    return (await response.json()) as T;
  }

  /** Create a Hermes session dedicated to one voice conversation. */
  async createSession(title: string): Promise<string> {
    const body = await this.#request<{ id?: string; session_id?: string }>(
      '/api/sessions',
      { method: 'POST', body: JSON.stringify({ title }) },
      15_000,
    );
    const sessionId = body.id ?? body.session_id;
    if (!sessionId) {
      throw new HermesError('Hermes created a session without an id', 502);
    }
    this.#logger.info('hermes session created', { sessionId });
    return sessionId;
  }

  /** Run one agent turn. This is the only path by which voice reaches Hermes. */
  async chat(sessionId: string, message: string): Promise<string> {
    const started = Date.now();
    const body = await this.#request<HermesChatResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
      { method: 'POST', body: JSON.stringify({ message }) },
      this.#timeoutMs,
    );

    const text = extractText(body.message?.content);
    this.#logger.info('hermes turn complete', {
      sessionId,
      durationMs: Date.now() - started,
      replyChars: text.length,
    });

    if (!text) {
      return 'Hermes completed the request but returned no spoken response.';
    }
    return text;
  }

  /** Liveness probe used by our own /health endpoint. */
  async health(): Promise<boolean> {
    try {
      await this.#request<unknown>('/health', { method: 'GET' }, 5_000);
      return true;
    } catch {
      return false;
    }
  }
}
