/**
 * Calls to our own server. Cookies carry authentication, so every request is
 * same-origin with credentials included.
 */

import type { RealtimeCredentials } from './realtime.js';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* keep the status-only message */
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export function login(password: string): Promise<{ ok: boolean; expiresAt: number }> {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/api/auth/logout', { method: 'POST' });
}

export function me(): Promise<{ authenticated: boolean; expiresAt: number }> {
  return request('/api/auth/me');
}

export function startSession(
  turnMode: 'push_to_talk' | 'hands_free',
  choice?: { provider: 'xai' | 'elevenlabs'; voiceId: string },
): Promise<RealtimeCredentials> {
  return request('/api/session/start', {
    method: 'POST',
    body: JSON.stringify({
      turnMode,
      provider: choice?.provider,
      voiceId: choice?.voiceId,
    }),
  });
}

export interface VoiceOptions {
  defaultProvider: 'xai' | 'elevenlabs';
  defaultVoiceId: string | null;
  providers: Array<{
    id: 'xai' | 'elevenlabs';
    label: string;
    voices: Array<{ id: string; name: string }>;
  }>;
}

export function voiceOptions(): Promise<VoiceOptions> {
  return request('/api/voice/options');
}

export function endSession(): Promise<{ ok: boolean }> {
  return request('/api/session/end', { method: 'POST' });
}

export function recordConversation(conversationId: string): Promise<{ ok: boolean }> {
  return request('/api/session/conversation', {
    method: 'POST',
    body: JSON.stringify({ conversationId }),
  });
}

export function askHermes(
  callId: string,
  requestText: string,
): Promise<{ callId: string; output: string; failed?: boolean }> {
  return request('/api/hermes/ask', {
    method: 'POST',
    body: JSON.stringify({ callId, request: requestText }),
  });
}
