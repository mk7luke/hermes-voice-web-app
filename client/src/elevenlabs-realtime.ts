/**
 * ElevenLabs Agents WebSocket client.
 *
 * Audio goes browser → ElevenLabs. Tool calls (ask_hermes) still come back
 * through our server. Custom voice ids are applied via the initiation payload
 * the server built — the page never holds the API key.
 */

import type { RealtimeHandlers } from './realtime.js';

export interface ElevenLabsCredentials {
  provider: 'elevenlabs';
  signedUrl: string;
  sampleRate: number;
  turnMode: 'push_to_talk' | 'hands_free';
  voiceId: string;
  voiceName?: string;
  initiation: Record<string, unknown>;
}

type ServerEvent = Record<string, unknown> & { type?: string };

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class ElevenLabsRealtimeClient {
  #socket: WebSocket | null = null;
  #intentionalClose = false;
  readonly #handlers: RealtimeHandlers;

  constructor(handlers: RealtimeHandlers) {
    this.#handlers = handlers;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  #discardSocket(): void {
    const socket = this.#socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    this.#socket = null;
    try {
      socket.close();
    } catch {
      /* already closing */
    }
  }

  connect(credentials: import('./realtime.js').RealtimeCredentials): void {
    if (!credentials.signedUrl) {
      this.#handlers.onError?.('Missing ElevenLabs signed URL.');
      return;
    }
    this.#discardSocket();
    this.#intentionalClose = false;

    const socket = new WebSocket(credentials.signedUrl);

    socket.onopen = () => {
      this.send(credentials.initiation ?? { type: 'conversation_initiation_client_data' });
      this.#handlers.onOpen?.();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      this.#dispatch(parsed);
    };

    socket.onerror = () => {
      this.#handlers.onError?.('Voice connection error.');
    };

    socket.onclose = () => {
      this.#handlers.onClose?.({ intentional: this.#intentionalClose });
    };

    this.#socket = socket;
  }

  #dispatch(event: ServerEvent): void {
    const type = event.type ?? '';

    if (type === 'ping') {
      const ping = event.ping_event as { event_id?: number; ping_ms?: number } | undefined;
      const eventId = ping?.event_id;
      const delay = typeof ping?.ping_ms === 'number' ? ping.ping_ms : 0;
      if (typeof eventId === 'number') {
        window.setTimeout(() => {
          this.send({ type: 'pong', event_id: eventId });
        }, delay);
      }
      return;
    }

    if (type === 'user_transcript') {
      const wrap = event.user_transcription_event as { user_transcript?: string } | undefined;
      const text = asString(wrap?.user_transcript);
      if (text) this.#handlers.onUserTranscript?.(text, true);
      return;
    }

    if (type === 'agent_response') {
      const wrap = event.agent_response_event as { agent_response?: string } | undefined;
      const text = asString(wrap?.agent_response);
      if (text) this.#handlers.onAssistantTranscript?.(text);
      return;
    }

    if (type === 'audio') {
      const wrap = event.audio_event as { audio_base_64?: string } | undefined;
      const audio = asString(wrap?.audio_base_64);
      if (audio) this.#handlers.onAudioDelta?.(audio);
      return;
    }

    if (type === 'interruption') {
      this.#handlers.onSpeechStarted?.();
      return;
    }

    if (type === 'client_tool_call') {
      const call = event.client_tool_call as
        | {
            tool_name?: string;
            tool_call_id?: string;
            parameters?: Record<string, unknown>;
          }
        | undefined;
      const callId = asString(call?.tool_call_id);
      const name = asString(call?.tool_name);
      if (callId && name) {
        this.#handlers.onToolCall?.({
          callId,
          name,
          args: JSON.stringify(call?.parameters ?? {}),
        });
      }
      return;
    }

    if (type === 'conversation_initiation_metadata') {
      const meta = event.conversation_initiation_metadata_event as
        | { conversation_id?: string }
        | undefined;
      const id = asString(meta?.conversation_id);
      if (id) this.#handlers.onConversationCreated?.(id);
      return;
    }

    if (type === 'error') {
      const error = event.error as { message?: string } | undefined;
      this.#handlers.onError?.(error?.message ?? 'The voice service reported an error.');
    }
  }

  send(payload: Record<string, unknown>): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(payload));
  }

  appendAudio(base64: string): void {
    this.send({ user_audio_chunk: base64 });
  }

  /** Push-to-talk release: stop sending; VAD closes the turn on silence. */
  commitTurn(): void {
    this.send({ type: 'user_activity' });
  }

  clearInput(): void {
    /* ElevenLabs has no input-buffer clear; we just stop sending chunks. */
  }

  cancelResponse(): void {
    this.send({ type: 'contextual_update', text: 'The user interrupted. Stop speaking.' });
  }

  sendToolResult(callId: string, output: string): void {
    this.send({
      type: 'client_tool_result',
      tool_call_id: callId,
      result: output,
      is_error: false,
    });
  }

  close(): void {
    this.#intentionalClose = true;
    this.#discardSocket();
  }
}
