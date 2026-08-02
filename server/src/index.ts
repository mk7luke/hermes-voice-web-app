/**
 * Entry point.
 *
 * Load with an env file in development:
 *   node --env-file=.env dist/server/index.js
 * Under systemd, use EnvironmentFile= instead.
 */

import { randomBytes } from 'node:crypto';

import { buildApp } from './app.js';
import { SessionStore } from './auth.js';
import { ConfigError, loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { HermesClient } from './hermes-client.js';
import { createLogger } from './logger.js';
import { XaiClient } from './xai-client.js';

const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Config errors are for a human at a terminal, so they go to stderr in
    // plain text rather than as JSON log lines.
    if (error instanceof ConfigError) {
      process.stderr.write(`\nConfiguration error: ${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);

  const context: AppContext = {
    config,
    logger,
    sessions: new SessionStore(config.sessionTtlMs),
    hermes: new HermesClient({
      baseUrl: config.hermesApiUrl,
      apiKey: config.hermesApiKey,
      sessionKey: config.hermesSessionKey,
      timeoutMs: config.hermesTimeoutMs,
      logger,
    }),
    xai: new XaiClient({ apiKey: config.xaiApiKey, logger }),
    // Rotating the salt per process means restarting invalidates nothing
    // important (sessions are in-memory anyway) while keeping the hash inputs
    // out of any on-disk artefact.
    passwordSalt: randomBytes(16).toString('hex'),
  };

  const app = await buildApp(context);

  const sweeper = setInterval(() => {
    const removed = context.sessions.sweep();
    if (removed > 0) logger.debug('swept expired sessions', { removed });
  }, SESSION_SWEEP_INTERVAL_MS);
  sweeper.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    clearInterval(sweeper);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });

  logger.info('hermes-voice listening', {
    host: config.host,
    port: config.port,
    hermesApiUrl: config.hermesApiUrl,
    voiceModel: config.xaiVoiceModel,
  });

  if (!config.cookieSecure) {
    logger.warn(
      'COOKIE_SECURE is false — acceptable for local http development only, ' +
        'never for a reachable deployment',
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal startup error: ${String(error)}\n`);
  process.exit(1);
});
