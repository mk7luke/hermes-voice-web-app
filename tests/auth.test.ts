import { describe, expect, it } from 'vitest';

import {
  SessionStore,
  signSessionId,
  verifyPassword,
  verifySessionId,
} from '../server/src/auth.js';

const SECRET = 'test-secret-that-is-at-least-32-chars';

describe('verifyPassword', () => {
  it('accepts the correct passphrase', async () => {
    await expect(verifyPassword('hunter2000', 'hunter2000', 'salt')).resolves.toBe(true);
  });

  it('rejects an incorrect passphrase', async () => {
    await expect(verifyPassword('wrong', 'hunter2000', 'salt')).resolves.toBe(false);
  });

  it('rejects a passphrase that only shares a prefix', async () => {
    await expect(verifyPassword('hunter20', 'hunter2000', 'salt')).resolves.toBe(false);
  });

  it('rejects an empty candidate against a real passphrase', async () => {
    await expect(verifyPassword('', 'hunter2000', 'salt')).resolves.toBe(false);
  });

  it('handles unicode and long passphrases without truncating', async () => {
    const passphrase = `${'✓'.repeat(64)}-ünïcode`;
    await expect(verifyPassword(passphrase, passphrase, 'salt')).resolves.toBe(true);
    await expect(verifyPassword(`${passphrase}x`, passphrase, 'salt')).resolves.toBe(false);
  });
});

describe('session cookie signing', () => {
  it('round-trips a session id', () => {
    const signed = signSessionId('abc123', SECRET);
    expect(verifySessionId(signed, SECRET)).toBe('abc123');
  });

  it('rejects a tampered id', () => {
    const signed = signSessionId('abc123', SECRET);
    const tampered = signed.replace('abc123', 'abc124');
    expect(verifySessionId(tampered, SECRET)).toBeNull();
  });

  it('rejects a signature made with a different secret', () => {
    const signed = signSessionId('abc123', 'a-completely-different-secret-value');
    expect(verifySessionId(signed, SECRET)).toBeNull();
  });

  it('rejects an unsigned value', () => {
    expect(verifySessionId('abc123', SECRET)).toBeNull();
  });

  it('rejects a malformed value without throwing', () => {
    expect(verifySessionId('', SECRET)).toBeNull();
    expect(verifySessionId('.', SECRET)).toBeNull();
    expect(verifySessionId('.sig', SECRET)).toBeNull();
  });
});

describe('SessionStore', () => {
  it('creates sessions with unguessable ids', () => {
    const store = new SessionStore(60_000);
    const first = store.create();
    const second = store.create();

    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThanOrEqual(32);
  });

  it('starts with no Hermes session bound', () => {
    const store = new SessionStore(60_000);
    expect(store.create().hermesSessionId).toBeNull();
  });

  it('retrieves a live session', () => {
    const store = new SessionStore(60_000);
    const session = store.create();
    expect(store.get(session.id)?.id).toBe(session.id);
  });

  it('refuses an expired session and drops it', () => {
    let now = 1_000;
    const store = new SessionStore(500, () => now);
    const session = store.create();

    now = 1_600; // past expiry
    expect(store.get(session.id)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('destroys a session on logout', () => {
    const store = new SessionStore(60_000);
    const session = store.create();
    store.destroy(session.id);
    expect(store.get(session.id)).toBeNull();
  });

  it('sweeps only expired sessions', () => {
    let now = 1_000;
    const store = new SessionStore(500, () => now);
    const expiring = store.create();

    now = 1_400;
    const fresh = store.create(); // expires at 1900

    now = 1_600; // expiring is past due, fresh is not
    expect(store.sweep()).toBe(1);
    expect(store.get(expiring.id)).toBeNull();
    expect(store.get(fresh.id)).not.toBeNull();
  });

  it('keeps per-session Hermes bindings isolated', () => {
    const store = new SessionStore(60_000);
    const a = store.create();
    const b = store.create();

    a.hermesSessionId = 'hermes-a';
    b.hermesSessionId = 'hermes-b';

    expect(store.get(a.id)?.hermesSessionId).toBe('hermes-a');
    expect(store.get(b.id)?.hermesSessionId).toBe('hermes-b');
  });
});
