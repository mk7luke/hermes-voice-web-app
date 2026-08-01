/**
 * Environment configuration.
 *
 * Parsed and validated once at boot. A misconfigured deployment should fail
 * loudly on startup rather than at the moment someone taps the talk button on
 * their phone, so every required value is checked here.
 */

export interface Config {
  readonly xaiApiKey: string;
  readonly xaiVoiceModel: string;
  readonly xaiVoice: string;
  readonly xaiTokenTtlSeconds: number;

  readonly hermesApiUrl: string;
  readonly hermesApiKey: string;
  readonly hermesSessionKey: string | null;
  readonly hermesTimeoutMs: number;

  readonly appPassword: string;
  readonly sessionSecret: string;
  readonly sessionTtlMs: number;

  readonly port: number;
  readonly host: string;
  readonly cookieSecure: boolean;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';

  readonly voiceInstructions: string;
}

/** xAI rejects ephemeral token lifetimes above one hour. */
export const MAX_XAI_TOKEN_TTL_SECONDS = 3600;

const DEFAULT_VOICE_INSTRUCTIONS = `You are the voice of Hermes, a personal AI agent.

You are a speech front-end, not the agent itself. Hermes holds the memory, the
tools, and the knowledge. Your job is to listen well, speak naturally, and route
real work to Hermes.

Rules:
- For anything that needs knowledge, memory, files, calculation, current
  information, or any action in the world, call the ask_hermes tool. Do not
  guess or answer from your own knowledge.
- You may answer directly only for pure conversational filler: greetings,
  acknowledgements, asking someone to repeat themselves.
- Before calling ask_hermes, say a brief natural acknowledgement such as "one
  sec" or "let me check" so the pause is not silent. Keep it to a few words.
- When ask_hermes returns, relay the answer conversationally. Do not read out
  formatting, markdown, URLs character by character, or code blocks verbatim —
  summarise those and offer detail if asked.
- Keep replies short. This is a spoken conversation on a phone, not an essay.
- If you are interrupted, stop immediately and listen.`;

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing required environment variable ${key}. See .env.example.`,
    );
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ConfigError(`${key} must be an integer, got "${raw}".`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${parsed}.`);
  }
  return parsed;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new ConfigError(`${key} must be true or false, got "${raw}".`);
}

function logLevel(env: NodeJS.ProcessEnv): Config['logLevel'] {
  const raw = optional(env, 'LOG_LEVEL', 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error. Got "${raw}".`);
}

function normaliseBaseUrl(raw: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${key} must be an absolute URL, got "${raw}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${key} must be http or https, got "${parsed.protocol}".`);
  }
  // Strip the trailing slash so callers can join paths without doubling up.
  return parsed.toString().replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new ConfigError(
      'SESSION_SECRET must be at least 32 characters. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  const appPassword = required(env, 'APP_PASSWORD');
  if (appPassword.length < 8) {
    throw new ConfigError('APP_PASSWORD must be at least 8 characters.');
  }

  const sessionTtlHours = integer(env, 'SESSION_TTL_HOURS', 168, { min: 1, max: 8760 });

  return {
    xaiApiKey: required(env, 'XAI_API_KEY'),
    xaiVoiceModel: optional(env, 'XAI_VOICE_MODEL', 'grok-voice-latest'),
    xaiVoice: optional(env, 'XAI_VOICE', 'eve'),
    xaiTokenTtlSeconds: integer(env, 'XAI_TOKEN_TTL_SECONDS', 600, {
      min: 60,
      max: MAX_XAI_TOKEN_TTL_SECONDS,
    }),

    hermesApiUrl: normaliseBaseUrl(
      optional(env, 'HERMES_API_URL', 'http://127.0.0.1:8642'),
      'HERMES_API_URL',
    ),
    hermesApiKey: required(env, 'API_SERVER_KEY'),
    hermesSessionKey: env.HERMES_SESSION_KEY?.trim() || null,
    hermesTimeoutMs: integer(env, 'HERMES_TIMEOUT_MS', 120_000, {
      min: 1_000,
      max: 600_000,
    }),

    appPassword,
    sessionSecret,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,

    port: integer(env, 'PORT', 8787, { min: 1, max: 65535 }),
    host: optional(env, 'HOST', '127.0.0.1'),
    cookieSecure: boolean(env, 'COOKIE_SECURE', true),
    logLevel: logLevel(env),

    voiceInstructions: optional(env, 'VOICE_INSTRUCTIONS', DEFAULT_VOICE_INSTRUCTIONS),
  };
}

export { ConfigError, DEFAULT_VOICE_INSTRUCTIONS };
