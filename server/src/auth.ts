/**
 * Passphrase authentication and server-side session state.
 *
 * Two things live here, and the split matters:
 *
 *  - The cookie carries only an opaque, signed session id.
 *  - Everything sensitive — most importantly the Hermes session id this browser
 *    is bound to — lives server-side, keyed by that id.
 *
 * That is what stops a client from naming its own Hermes session and reaching
 * conversations belonging to other gateway platforms.
 */

import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE = 'hv_session';

/** Salt is fixed per-process; the passphrase never leaves this host. */
const SCRYPT_KEYLEN = 64;

/**
 * Compare a candidate passphrase against the configured one in constant time.
 *
 * Both sides are hashed first. Hashing the candidate means the comparison
 * length is fixed regardless of what was submitted, so the timing of a wrong
 * guess reveals nothing about the real passphrase's length.
 */
export async function verifyPassword(
  candidate: string,
  expected: string,
  salt: string,
): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([
    scrypt(candidate, salt, SCRYPT_KEYLEN) as Promise<Buffer>,
    scrypt(expected, salt, SCRYPT_KEYLEN) as Promise<Buffer>,
  ]);
  return timingSafeEqual(candidateHash, expectedHash);
}

export interface AppSession {
  readonly id: string;
  /** Hermes session this browser is bound to. Never client-supplied. */
  hermesSessionId: string | null;
  /** xAI conversation id, retained so a reconnect can resume. */
  conversationId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  lastSeenAt: number;
}

/**
 * In-memory session store.
 *
 * Deliberately not persisted: this is a single-user personal app, and losing
 * sessions on restart means "log in again", which is an acceptable trade for
 * having no session database to secure or migrate.
 */
export class SessionStore {
  readonly #sessions = new Map<string, AppSession>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  create(): AppSession {
    const now = this.#now();
    const session: AppSession = {
      id: randomBytes(32).toString('base64url'),
      hermesSessionId: null,
      conversationId: null,
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      lastSeenAt: now,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): AppSession | null {
    const session = this.#sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(id);
      return null;
    }
    session.lastSeenAt = this.#now();
    return session;
  }

  destroy(id: string): void {
    this.#sessions.delete(id);
  }

  /** Drop expired entries. Called periodically so idle memory stays flat. */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#sessions.size;
  }
}

/**
 * Sign a session id so a forged cookie cannot mint a valid-looking session.
 *
 * Fastify's cookie plugin can sign for us, but doing it explicitly keeps the
 * format obvious and testable: `<id>.<hmac>`.
 */
export function signSessionId(id: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(id).digest('base64url');
  return `${id}.${mac}`;
}

export function verifySessionId(signed: string, secret: string): string | null {
  const separator = signed.lastIndexOf('.');
  if (separator <= 0) return null;

  const id = signed.slice(0, separator);
  const mac = signed.slice(separator + 1);
  const expected = createHmac('sha256', secret).update(id).digest('base64url');

  const macBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (macBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(macBuffer, expectedBuffer)) return null;

  return id;
}
