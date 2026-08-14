/**
 * Environment configuration.
 *
 * Parsed and validated once at boot. A misconfigured deployment should fail
 * loudly on startup rather than at the moment someone taps the talk button on
 * their phone, so every required value is checked here.
 */

export type VoiceProvider = 'xai' | 'elevenlabs';

/**
 * How the app decides a request is authorised.
 *
 * `passphrase` is the default and the only self-contained option: the app
 * authenticates the browser itself with `APP_PASSWORD`.
 *
 * `proxy` removes that check entirely and treats every request that arrives as
 * already authenticated, for deployments behind an identity-aware proxy
 * (Cloudflare Access, Tailscale, oauth2-proxy). It is only safe when the origin
 * cannot be reached except through that proxy — a Cloudflare tunnel, a tailnet
 * address, a loopback bind. An open port with `proxy` mode is an unauthenticated
 * route to someone's agent.
 */
export type AuthMode = 'passphrase' | 'proxy';

export interface Config {
  readonly defaultVoiceProvider: VoiceProvider;
  readonly xaiEnabled: boolean;
  readonly elevenlabsEnabled: boolean;

  readonly xaiApiKey: string | null;
  readonly xaiVoiceModel: string;
  readonly xaiVoice: string;
  readonly xaiTokenTtlSeconds: number;

  readonly elevenlabsApiKey: string | null;
  readonly elevenlabsVoiceId: string | null;
  readonly elevenlabsAgentId: string | null;
  /** Optional curated list. Empty means "use the account catalogue". */
  readonly elevenlabsVoices: ReadonlyArray<{ id: string; name: string }>;

  readonly hermesApiUrl: string;
  readonly hermesApiKey: string;
  readonly hermesSessionKey: string | null;
  readonly hermesTimeoutMs: number;

  readonly authMode: AuthMode;
  /** Null in `proxy` mode, where nothing checks a passphrase. */
  readonly appPassword: string | null;
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

const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function parseAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  const raw = env.AUTH_MODE?.trim().toLowerCase();
  if (!raw) return 'passphrase';
  if (raw === 'passphrase' || raw === 'proxy') return raw;
  throw new ConfigError(`AUTH_MODE must be passphrase or proxy, got "${raw}".`);
}

function parseVoiceProvider(env: NodeJS.ProcessEnv): VoiceProvider | null {
  const raw = env.VOICE_PROVIDER?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'xai' || raw === 'elevenlabs') return raw;
  throw new ConfigError(`VOICE_PROVIDER must be xai or elevenlabs, got "${raw}".`);
}

function parseNamedVoices(raw: string | undefined): Array<{ id: string; name: string }> {
  if (!raw?.trim()) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const colon = piece.lastIndexOf(':');
    const name = colon > 0 ? piece.slice(0, colon).trim() : piece;
    const id = colon > 0 ? piece.slice(colon + 1).trim() : piece;
    if (!VOICE_ID_RE.test(id)) {
      throw new ConfigError(
        `ELEVENLABS_VOICES entry "${piece}" is not a valid voice id.`,
      );
    }
    out.push({ id, name: name || id });
  }
  return out;
}

function optionalVoiceId(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  if (!value) return null;
  if (!VOICE_ID_RE.test(value)) {
    throw new ConfigError(`${key} must be an ElevenLabs voice id (8-64 letters/digits).`);
  }
  return value;
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

  const authMode = parseAuthMode(env);

  // In proxy mode nothing checks a passphrase, so requiring one would be
  // theatre — an operator would set a value they can never use and might
  // reasonably believe still protects something.
  let appPassword: string | null = null;
  if (authMode === 'passphrase') {
    appPassword = required(env, 'APP_PASSWORD');
    if (appPassword.length < 8) {
      throw new ConfigError('APP_PASSWORD must be at least 8 characters.');
    }
  } else if (env.APP_PASSWORD?.trim()) {
    throw new ConfigError(
      'APP_PASSWORD is set but AUTH_MODE=proxy ignores it. Remove one of the two ' +
        'so it is clear what is actually guarding this app.',
    );
  }

  const sessionTtlHours = integer(env, 'SESSION_TTL_HOURS', 168, { min: 1, max: 8760 });

  const xaiApiKey = env.XAI_API_KEY?.trim() || null;
  const elevenlabsApiKey = env.ELEVENLABS_API_KEY?.trim() || null;
  const elevenlabsVoiceId = optionalVoiceId(env, 'ELEVENLABS_VOICE_ID');
  const elevenlabsVoices = parseNamedVoices(env.ELEVENLABS_VOICES);
  const elevenlabsEnabled = Boolean(elevenlabsApiKey && elevenlabsVoiceId);
  const xaiEnabled = Boolean(xaiApiKey);

  if (!xaiEnabled && !elevenlabsEnabled) {
    throw new ConfigError(
      'Configure at least one voice provider: XAI_API_KEY, or ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID.',
    );
  }
  if (elevenlabsApiKey && !elevenlabsVoiceId) {
    throw new ConfigError(
      'ELEVENLABS_API_KEY is set but ELEVENLABS_VOICE_ID is missing. Custom voice ids are required.',
    );
  }

  const requested = parseVoiceProvider(env);
  let defaultVoiceProvider: VoiceProvider;
  if (requested) {
    if (requested === 'xai' && !xaiEnabled) {
      throw new ConfigError('VOICE_PROVIDER=xai but XAI_API_KEY is not set.');
    }
    if (requested === 'elevenlabs' && !elevenlabsEnabled) {
      throw new ConfigError(
        'VOICE_PROVIDER=elevenlabs but ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not set.',
      );
    }
    defaultVoiceProvider = requested;
  } else {
    defaultVoiceProvider = xaiEnabled ? 'xai' : 'elevenlabs';
  }

  return {
    defaultVoiceProvider,
    xaiEnabled,
    elevenlabsEnabled,

    xaiApiKey,
    xaiVoiceModel: optional(env, 'XAI_VOICE_MODEL', 'grok-voice-latest'),
    xaiVoice: optional(env, 'XAI_VOICE', 'eve'),
    xaiTokenTtlSeconds: integer(env, 'XAI_TOKEN_TTL_SECONDS', 600, {
      min: 60,
      max: MAX_XAI_TOKEN_TTL_SECONDS,
    }),

    elevenlabsApiKey,
    elevenlabsVoiceId,
    elevenlabsAgentId: env.ELEVENLABS_AGENT_ID?.trim() || null,
    elevenlabsVoices,

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

    authMode,
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

export { ConfigError, DEFAULT_VOICE_INSTRUCTIONS, VOICE_ID_RE };
