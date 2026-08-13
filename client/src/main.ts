/**
 * Application orchestration: ties the talk button, the audio engine, the xAI
 * socket, and the Hermes tool bridge together.
 */

import * as api from './api.js';
import { ApiError } from './api.js';
import { AudioEngine, base64ToPcm16, pcm16ToBase64 } from './audio.js';
import { ElevenLabsRealtimeClient } from './elevenlabs-realtime.js';
import { RealtimeClient, type RealtimeCredentials, type RealtimeHandlers } from './realtime.js';
import { Ui, type AppState } from './ui.js';
import './styles.css';

type TurnMode = 'push_to_talk' | 'hands_free';
type VoiceProvider = 'xai' | 'elevenlabs';

const MAX_RECONNECT_ATTEMPTS = 5;
const MODE_STORAGE_KEY = 'hermes-voice.turn-mode';
const VOICE_STORAGE_KEY = 'hermes-voice.voice-choice';

interface Transport {
  readonly connected: boolean;
  connect(credentials: RealtimeCredentials): void;
  appendAudio(base64: string): void;
  commitTurn(): void;
  clearInput(): void;
  cancelResponse(): void;
  sendToolResult(callId: string, output: string): void;
  close(): void;
}

class App {
  readonly #ui = new Ui();
  readonly #xai: RealtimeClient;
  readonly #eleven: ElevenLabsRealtimeClient;
  #transport: Transport;
  #audio: AudioEngine | null = null;
  #audioRate = 0;

  #state: AppState = 'locked';
  #turnMode: TurnMode = 'push_to_talk';
  #provider: VoiceProvider = 'xai';
  #voiceId = '';
  #sessionActive = false;
  #capturing = false;
  #reconnectAttempts = 0;
  #reconnectTimer: number | null = null;

  constructor() {
    const handlers: RealtimeHandlers = {
      onOpen: () => {
        this.#reconnectAttempts = 0;
        this.#ui.hideBanner();
        this.#setState(this.#turnMode === 'hands_free' ? 'listening' : 'idle');
      },

      onConversationCreated: (conversationId) => {
        // Stored server-side so a reconnect can resume this conversation.
        void api.recordConversation(conversationId).catch(() => {
          /* continuity is best-effort */
        });
      },

      onAudioDelta: (base64) => {
        this.#audio?.play(base64ToPcm16(base64));
      },

      onAssistantTranscript: (delta) => {
        this.#ui.appendTranscript('assistant', delta);
      },

      onUserTranscript: (text, final) => {
        // Interim transcripts replace; the final one closes the bubble.
        this.#ui.appendTranscript('user', text, true);
        if (final) this.#ui.breakTranscript();
      },

      onSpeechStarted: () => {
        // Server VAD detected the user talking over the assistant: cut playback
        // locally first so it feels instant, then tell the model to stop.
        this.#bargeIn();
      },

      onToolCall: (call) => {
        void this.#handleToolCall(call);
      },

      onResponseDone: () => {
        this.#ui.breakTranscript();
        if (this.#state === 'thinking' || this.#state === 'speaking') {
          this.#setState(this.#turnMode === 'hands_free' ? 'listening' : 'idle');
        }
      },

      onError: (message) => {
        this.#ui.showBanner(message);
      },

      onClose: ({ intentional }) => {
        if (intentional || !this.#sessionActive) return;
        this.#scheduleReconnect();
      },
    };
    this.#xai = new RealtimeClient(handlers);
    this.#eleven = new ElevenLabsRealtimeClient(handlers);
    this.#transport = this.#xai;
  }

  async start(): Promise<void> {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === 'hands_free' || stored === 'push_to_talk') {
      this.#turnMode = stored;
    }
    this.#ui.setMode(this.#turnMode);
    this.#updateTalkLabel();

    this.#wireLogin();
    this.#wireControls();

    try {
      await api.me();
      this.#onAuthenticated();
    } catch {
      this.#ui.showLogin();
      this.#setState('locked');
    }
  }

  // --- Authentication -------------------------------------------------------

  #wireLogin(): void {
    this.#ui.loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.#submitLogin();
    });
  }

  async #submitLogin(): Promise<void> {
    const password = this.#ui.passwordInput.value;
    if (!password) return;

    this.#ui.loginError.textContent = '';
    try {
      await api.login(password);
      this.#ui.passwordInput.value = '';
      this.#onAuthenticated();
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : 'Incorrect passphrase.';
      this.#ui.loginError.textContent = message;
    }
  }

  #onAuthenticated(): void {
    this.#ui.showApp();
    this.#setState('idle');
    void this.#loadVoiceOptions();
  }

  // --- Controls -------------------------------------------------------------

  #wireControls(): void {
    const button = this.#ui.talkButton;

    // Pointer events cover mouse and touch uniformly. `touch-action: none` in
    // CSS keeps a press from scrolling the page instead of talking.
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      void this.#onPressStart();
    });

    const release = (event: PointerEvent) => {
      if (button.hasPointerCapture(event.pointerId)) {
        button.releasePointerCapture(event.pointerId);
      }
      void this.#onPressEnd();
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);

    this.#ui.muteButton.addEventListener('click', () => {
      if (!this.#audio) return;
      this.#audio.setMuted(!this.#audio.muted);
      this.#ui.setMuted(this.#audio.muted);
    });

    this.#ui.modeButton.addEventListener('click', () => {
      void this.#toggleMode();
    });

    this.#ui.voiceSelect.addEventListener('change', () => {
      void this.#onVoicePicked(this.#ui.voiceSelect.value);
    });

    this.#ui.endButton.addEventListener('click', () => {
      void this.#endSession();
    });

    // Closing the tab or backgrounding the app must release the microphone and
    // the socket; a voice session left running in a hidden tab is both a
    // privacy problem and a billing one.
    window.addEventListener('pagehide', () => {
      void this.#teardown();
    });
  }

  #updateTalkLabel(): void {
    if (this.#turnMode === 'hands_free') {
      this.#ui.setTalkLabel(this.#sessionActive ? 'Tap to stop' : 'Tap to start');
    } else {
      this.#ui.setTalkLabel('Hold to talk');
    }
  }

  async #toggleMode(): Promise<void> {
    this.#turnMode = this.#turnMode === 'hands_free' ? 'push_to_talk' : 'hands_free';
    localStorage.setItem(MODE_STORAGE_KEY, this.#turnMode);
    this.#ui.setMode(this.#turnMode);
    this.#updateTalkLabel();

    // Turn detection is fixed at session creation, so switching modes needs a
    // fresh session.
    if (this.#sessionActive) {
      await this.#teardown();
      this.#ui.addSystemNote('Switched mode — session restarted.');
      this.#setState('idle');
    }
  }

  async #loadVoiceOptions(): Promise<void> {
    try {
      const catalogue = await api.voiceOptions();
      const options: Array<{ value: string; label: string }> = [];
      for (const provider of catalogue.providers) {
        for (const voice of provider.voices) {
          options.push({
            value: `${provider.id}:${voice.id}`,
            label: `${provider.label} · ${voice.name}`,
          });
        }
      }
      const stored = localStorage.getItem(VOICE_STORAGE_KEY);
      const fallback = `${catalogue.defaultProvider}:${catalogue.defaultVoiceId ?? ''}`;
      const selected = stored && options.some((option) => option.value === stored) ? stored : fallback;
      this.#applyVoiceChoice(selected);
      this.#ui.setVoiceOptions(options, selected);
    } catch {
      /* picker is optional; session start still uses server default */
    }
  }

  #applyVoiceChoice(value: string): void {
    const colon = value.indexOf(':');
    if (colon < 0) return;
    const provider = value.slice(0, colon);
    const voiceId = value.slice(colon + 1);
    if (provider !== 'xai' && provider !== 'elevenlabs') return;
    this.#provider = provider;
    this.#voiceId = voiceId;
    localStorage.setItem(VOICE_STORAGE_KEY, value);
  }

  async #onVoicePicked(value: string): Promise<void> {
    this.#applyVoiceChoice(value);
    if (this.#sessionActive) {
      await this.#teardown();
      this.#ui.addSystemNote('Switched voice — session restarted.');
      this.#setState('idle');
    }
  }

  // --- Talking --------------------------------------------------------------

  async #onPressStart(): Promise<void> {
    if (this.#turnMode === 'hands_free') {
      // In hands-free the button is a session toggle, handled on release.
      return;
    }

    try {
      await this.#ensureSession();
    } catch {
      return;
    }

    // Pressing while the assistant is speaking means "stop and listen to me".
    this.#bargeIn();
    this.#transport.clearInput();
    this.#capturing = true;
    this.#setState('listening');
  }

  async #onPressEnd(): Promise<void> {
    if (this.#turnMode === 'hands_free') {
      if (this.#sessionActive) {
        await this.#endSession();
      } else {
        try {
          await this.#ensureSession();
          this.#capturing = true;
          this.#setState('listening');
        } catch {
          /* banner already shown */
        }
      }
      this.#updateTalkLabel();
      return;
    }

    if (!this.#capturing) return;
    this.#capturing = false;
    this.#transport.commitTurn();
    this.#setState('thinking');
  }

  #bargeIn(): void {
    this.#audio?.stopPlayback();
    if (this.#state === 'speaking') {
      this.#transport.cancelResponse();
    }
  }

  // --- Session lifecycle ----------------------------------------------------

  async #ensureSession(): Promise<void> {
    if (this.#sessionActive && this.#transport.connected) return;

    this.#setState('connecting');
    try {
      const credentials = await api.startSession(this.#turnMode, {
        provider: this.#provider,
        voiceId: this.#voiceId,
      });

      if (!this.#audio || this.#audioRate !== credentials.sampleRate) {
        await this.#audio?.close();
        this.#audio = new AudioEngine({
          sampleRate: credentials.sampleRate,
          onAudio: (pcm16) => {
            // In push-to-talk, only stream while the button is held.
            if (this.#turnMode === 'push_to_talk' && !this.#capturing) return;
            this.#transport.appendAudio(pcm16ToBase64(pcm16));
          },
          onPlaybackStateChange: (speaking) => {
            if (speaking) {
              this.#setState('speaking');
            } else if (this.#state === 'speaking') {
              this.#setState(this.#turnMode === 'hands_free' ? 'listening' : 'idle');
            }
          },
        });
        this.#audioRate = credentials.sampleRate;
      }

      // Requires a user gesture on iOS — this call chain always originates
      // from the talk button, which satisfies that.
      await this.#audio.init();
      this.#ui.setMuted(this.#audio.muted);

      this.#useTransport(credentials);
      this.#sessionActive = true;
      this.#updateTalkLabel();
    } catch (error) {
      this.#sessionActive = false;
      this.#setState('error');

      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.#ui.showBanner(
          'Microphone access was denied. Allow it in your browser settings, then try again.',
        );
      } else if (error instanceof ApiError && error.status === 401) {
        this.#ui.showLogin();
        this.#setState('locked');
      } else {
        const message =
          error instanceof ApiError ? error.message : 'Could not start the voice session.';
        this.#ui.showBanner(message);
      }
      throw error;
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;

    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.#ui.showBanner('Lost the connection. Tap to talk to start again.');
      this.#sessionActive = false;
      this.#setState('error');
      this.#updateTalkLabel();
      return;
    }

    this.#reconnectAttempts += 1;
    // Exponential backoff, capped — a phone changing cells recovers quickly,
    // and a genuinely dead server should not be hammered.
    const delay = Math.min(1000 * 2 ** (this.#reconnectAttempts - 1), 8000);

    this.#setState('reconnecting');
    this.#ui.showBanner(`Connection lost. Reconnecting…`, 'info');

    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnect();
    }, delay);
  }

  async #reconnect(): Promise<void> {
    try {
      // Always mint a fresh token: the previous one may well have expired,
      // and the server hands back the conversation id needed to resume.
      const credentials = await api.startSession(this.#turnMode, {
        provider: this.#provider,
        voiceId: this.#voiceId,
      });
      this.#useTransport(credentials);
    } catch {
      this.#scheduleReconnect();
    }
  }

  async #handleToolCall(call: {
    callId: string;
    name: string;
    args: string;
  }): Promise<void> {
    if (call.name !== 'ask_hermes') {
      this.#transport.sendToolResult(call.callId, `Unknown tool: ${call.name}`);
      return;
    }

    let requestText = '';
    try {
      const parsed = JSON.parse(call.args) as { request?: unknown };
      if (typeof parsed.request === 'string') requestText = parsed.request;
    } catch {
      /* fall through to the empty-request guard */
    }

    if (!requestText) {
      this.#transport.sendToolResult(call.callId, 'No request was provided.');
      return;
    }

    this.#setState('thinking');
    this.#ui.addSystemNote(`Asking Hermes: ${requestText}`);

    try {
      const result = await api.askHermes(call.callId, requestText);
      this.#transport.sendToolResult(call.callId, result.output);
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 401
          ? 'The session expired. Please sign in again.'
          : 'Hermes could not be reached.';
      this.#ui.showBanner(message);
      this.#transport.sendToolResult(call.callId, message);
    }
  }

  async #endSession(): Promise<void> {
    await this.#teardown();
    this.#ui.addSystemNote('Session ended.');
    this.#setState('idle');
    this.#updateTalkLabel();
  }

  /** Close the socket, release the mic, and drop server-side conversation state. */
  async #teardown(): Promise<void> {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#reconnectAttempts = 0;
    this.#capturing = false;
    this.#sessionActive = false;

    this.#transport.close();
    await this.#audio?.close();
    this.#audio = null;
    this.#audioRate = 0;

    try {
      await api.endSession();
    } catch {
      /* the local teardown is what matters for privacy */
    }
  }

  #useTransport(credentials: RealtimeCredentials): void {
    this.#xai.close();
    this.#eleven.close();
    this.#transport = credentials.provider === 'elevenlabs' ? this.#eleven : this.#xai;
    this.#transport.connect(credentials);
  }

  #setState(state: AppState): void {
    this.#state = state;
    this.#ui.setState(state);
  }
}

void new App().start();

// Register the service worker for installability. Failure is non-fatal — the
// app works fine as a normal page.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* ignore */
    });
  });
}
