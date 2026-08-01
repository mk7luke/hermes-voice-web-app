/**
 * xAI Realtime Voice WebSocket client.
 *
 * Connects the browser straight to xAI for audio, which is the whole point of
 * the ephemeral-token design: the audio path has no extra hop. Tool calls take
 * the slower, trusted route back through our server.
 */

export interface RealtimeCredentials {
  token: string;
  expiresAt: number;
  realtimeUrl: string;
  model: string;
  sampleRate: number;
  turnMode: 'push_to_talk' | 'hands_free';
  session: Record<string, unknown>;
  conversationId: string | null;
}

export interface RealtimeHandlers {
  onOpen?: () => void;
  onAudioDelta?: (base64: string) => void;
  onAssistantTranscript?: (delta: string) => void;
  onUserTranscript?: (text: string, final: boolean) => void;
  onToolCall?: (call: { callId: string; name: string; args: string }) => void;
  onSpeechStarted?: () => void;
  onResponseDone?: () => void;
  onConversationCreated?: (conversationId: string) => void;
  onError?: (message: string) => void;
  onClose?: (info: { intentional: boolean }) => void;
}

type ServerEvent = Record<string, unknown> & { type?: string };

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class RealtimeClient {
  #socket: WebSocket | null = null;
  #intentionalClose = false;
  readonly #handlers: RealtimeHandlers;

  constructor(handlers: RealtimeHandlers) {
    this.#handlers = handlers;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Detach and close the current socket, if any.
   *
   * Detaching the handlers before closing is the important part. A superseded
   * socket still fires `close`, and its handler would otherwise re-enter the
   * reconnect loop — stacking a second socket on top of the new one. A stale
   * `open` is equally bad: `send()` writes to `#socket`, so a late handshake
   * would push a duplicate `session.update` down the *current* connection.
   */
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
      /* already closing or closed */
    }
  }

  connect(credentials: RealtimeCredentials): void {
    // Reconnecting while a socket is still CONNECTING is reachable: pressing
    // talk during the 'connecting' state re-enters ensureSession(), whose
    // `connected` guard is false for a socket that has not finished opening.
    this.#discardSocket();

    this.#intentionalClose = false;

    const url = new URL(credentials.realtimeUrl);
    url.searchParams.set('model', credentials.model);
    // Resuming keeps the conversation intact across a dropped connection.
    if (credentials.conversationId) {
      url.searchParams.set('conversation_id', credentials.conversationId);
    }

    // Browsers cannot set WebSocket headers, so xAI takes the ephemeral token
    // as a subprotocol instead.
    const socket = new WebSocket(url.toString(), [
      `xai-client-secret.${credentials.token}`,
    ]);

    socket.onopen = () => {
      // The session was built server-side; send it verbatim.
      this.send({ type: 'session.update', session: credentials.session });
      this.#handlers.onOpen?.();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return; // binary transport unused
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

    switch (type) {
      case 'conversation.created': {
        const conversation = event.conversation as { id?: string } | undefined;
        const id = conversation?.id ?? asString(event.conversation_id);
        if (id) this.#handlers.onConversationCreated?.(id);
        return;
      }

      // The docs list both spellings for assistant audio; accept either rather
      // than betting on one.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const delta = asString(event.delta);
        if (delta) this.#handlers.onAudioDelta?.(delta);
        return;
      }

      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        const delta = asString(event.delta);
        if (delta) this.#handlers.onAssistantTranscript?.(delta);
        return;
      }

      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.input_audio_transcription.updated': {
        const text = asString(event.delta) || asString(event.transcript);
        if (text) this.#handlers.onUserTranscript?.(text, false);
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = asString(event.transcript);
        if (text) this.#handlers.onUserTranscript?.(text, true);
        return;
      }

      case 'response.function_call_arguments.done': {
        const callId = asString(event.call_id);
        const name = asString(event.name);
        if (callId && name) {
          this.#handlers.onToolCall?.({
            callId,
            name,
            args: asString(event.arguments) || '{}',
          });
        }
        return;
      }

      case 'input_audio_buffer.speech_started': {
        this.#handlers.onSpeechStarted?.();
        return;
      }

      case 'response.done': {
        this.#handlers.onResponseDone?.();
        return;
      }

      case 'error': {
        const error = event.error as { message?: string } | undefined;
        this.#handlers.onError?.(error?.message ?? 'The voice service reported an error.');
        return;
      }

      default:
        // Unknown events are expected — the protocol emits far more than this
        // app needs, and new ones should not break a running session.
        return;
    }
  }

  send(payload: Record<string, unknown>): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(payload));
  }

  appendAudio(base64: string): void {
    this.send({ type: 'input_audio_buffer.append', audio: base64 });
  }

  /** Push-to-talk release: close the turn and ask for a response. */
  commitTurn(): void {
    this.send({ type: 'input_audio_buffer.commit' });
    this.send({ type: 'response.create' });
  }

  clearInput(): void {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /** Stop the assistant mid-sentence. */
  cancelResponse(): void {
    this.send({ type: 'response.cancel' });
  }

  /** Return a tool result and let the model continue speaking. */
  sendToolResult(callId: string, output: string): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.send({ type: 'response.create' });
  }

  close(): void {
    this.#intentionalClose = true;
    this.#discardSocket();
  }
}
