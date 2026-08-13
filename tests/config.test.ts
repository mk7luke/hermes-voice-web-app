import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../server/src/config.js';

/** A minimal environment that passes validation. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    XAI_API_KEY: 'xai-test-key',
    API_SERVER_KEY: 'hermes-test-key',
    APP_PASSWORD: 'a-long-enough-password',
    SESSION_SECRET: 'x'.repeat(32),
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = loadConfig(baseEnv());

    expect(config.xaiVoiceModel).toBe('grok-voice-latest');
    expect(config.hermesApiUrl).toBe('http://127.0.0.1:8642');
    expect(config.port).toBe(8787);
    expect(config.cookieSecure).toBe(true);
    expect(config.xaiTokenTtlSeconds).toBe(600);
    expect(config.voiceInstructions).toContain('ask_hermes');
  });

  it.each(['XAI_API_KEY', 'API_SERVER_KEY', 'APP_PASSWORD', 'SESSION_SECRET'])(
    'rejects a missing %s',
    (key) => {
      const env = baseEnv();
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );

  it('rejects a short session secret', () => {
    expect(() => loadConfig(baseEnv({ SESSION_SECRET: 'too-short' }))).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects a short app password', () => {
    expect(() => loadConfig(baseEnv({ APP_PASSWORD: 'abc' }))).toThrow(
      /at least 8 characters/,
    );
  });

  it("rejects an xAI token TTL above the provider's one hour cap", () => {
    expect(() => loadConfig(baseEnv({ XAI_TOKEN_TTL_SECONDS: '7200' }))).toThrow(
      /between 60 and 3600/,
    );
  });

  it('strips a trailing slash from the Hermes URL so paths join cleanly', () => {
    const config = loadConfig(baseEnv({ HERMES_API_URL: 'http://hermes.local:8642/' }));
    expect(config.hermesApiUrl).toBe('http://hermes.local:8642');
  });

  it('rejects a non-absolute Hermes URL', () => {
    expect(() => loadConfig(baseEnv({ HERMES_API_URL: '127.0.0.1:8642' }))).toThrow(
      /absolute URL/,
    );
  });

  it('rejects a non-boolean COOKIE_SECURE rather than silently defaulting', () => {
    expect(() => loadConfig(baseEnv({ COOKIE_SECURE: 'maybe' }))).toThrow(/true or false/);
  });

  it('converts SESSION_TTL_HOURS to milliseconds', () => {
    const config = loadConfig(baseEnv({ SESSION_TTL_HOURS: '2' }));
    expect(config.sessionTtlMs).toBe(2 * 60 * 60 * 1000);
  });
});

describe('AUTH_MODE', () => {
  it('defaults to passphrase', () => {
    expect(loadConfig(baseEnv()).authMode).toBe('passphrase');
  });

  it('drops the APP_PASSWORD requirement in proxy mode', () => {
    const env = baseEnv({ AUTH_MODE: 'proxy' });
    delete env.APP_PASSWORD;
    const config = loadConfig(env);
    expect(config.authMode).toBe('proxy');
    expect(config.appPassword).toBeNull();
  });

  it('refuses a passphrase that proxy mode would silently ignore', () => {
    // Setting both leaves an operator believing a passphrase still guards the
    // app when nothing reads it.
    expect(() => loadConfig(baseEnv({ AUTH_MODE: 'proxy' }))).toThrow(/ignores it/);
  });

  it('rejects an unknown mode', () => {
    expect(() => loadConfig(baseEnv({ AUTH_MODE: 'oauth' }))).toThrow(ConfigError);
  });
});
