/**
 * Mints short-lived xAI Realtime client secrets.
 *
 * The browser cannot hold `XAI_API_KEY`, and browsers cannot set WebSocket
 * headers either. xAI's answer to both is an ephemeral token passed as a
 * WebSocket subprotocol. This module is the only place the long-lived key is
 * used.
 *
 *   POST https://api.x.ai/v1/realtime/client_secrets
 *     { expires_after: { seconds }, session: {...} }
 *   => { value, expires_at }
 */

import type { Logger } from './logger.js';

const XAI_CLIENT_SECRETS_URL = 'https://api.x.ai/v1/realtime/client_secrets';

export class XaiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'XaiError';
    this.status = status;
  }
}

export interface EphemeralToken {
  /** Bearer value the browser passes as the `xai-client-secret.<value>` subprotocol. */
  readonly value: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export interface XaiClientOptions {
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class XaiClient {
  readonly #apiKey: string;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;

  constructor(options: XaiClientOptions) {
    this.#apiKey = options.apiKey;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async createEphemeralToken(
    ttlSeconds: number,
    session: Record<string, unknown>,
  ): Promise<EphemeralToken> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    try {
      response = await this.#fetch(XAI_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expires_after: { seconds: ttlSeconds },
          session,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new XaiError('xAI token request timed out', 504);
      }
      throw new XaiError('Could not reach the xAI API', 502);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Read the body for diagnostics but never log it verbatim — an error
      // envelope from a credentials endpoint is exactly where a token might
      // be echoed back.
      let detail = '';
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        /* ignore */
      }
      this.#logger.error('xAI refused to mint an ephemeral token', {
        status: response.status,
      });
      throw new XaiError(
        detail || `xAI returned ${response.status} when minting a token`,
        response.status,
      );
    }

    const body = (await response.json()) as { value?: string; expires_at?: number };
    if (!body.value) {
      throw new XaiError('xAI returned a token response without a value', 502);
    }

    const expiresAt =
      typeof body.expires_at === 'number'
        ? body.expires_at
        : Math.floor(Date.now() / 1000) + ttlSeconds;

    this.#logger.info('minted xAI ephemeral token', { ttlSeconds, expiresAt });
    return { value: body.value, expiresAt };
  }
}
