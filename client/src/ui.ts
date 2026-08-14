/**
 * DOM rendering. Deliberately plain: query the elements once, mutate them
 * directly. A framework would be more machinery than this screen justifies.
 */

export type AppState =
  | 'locked'
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'error';

const STATUS_TEXT: Record<AppState, string> = {
  locked: 'Locked',
  idle: 'Ready',
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Hermes is thinking…',
  speaking: 'Speaking',
  reconnecting: 'Reconnecting…',
  error: 'Error',
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

export class Ui {
  readonly loginView = element<HTMLDivElement>('login-view');
  readonly appView = element<HTMLDivElement>('app-view');
  readonly loginForm = element<HTMLFormElement>('login-form');
  readonly passwordInput = element<HTMLInputElement>('password');
  readonly loginError = element<HTMLParagraphElement>('login-error');

  readonly talkButton = element<HTMLButtonElement>('talk-button');
  readonly talkLabel = element<HTMLSpanElement>('talk-label');
  readonly statusDot = element<HTMLSpanElement>('status-dot');
  readonly statusText = element<HTMLSpanElement>('status-text');
  readonly transcript = element<HTMLDivElement>('transcript');
  readonly muteButton = element<HTMLButtonElement>('mute-button');
  readonly modeButton = element<HTMLButtonElement>('mode-button');
  readonly voiceSelect = element<HTMLSelectElement>('voice-select');
  readonly voicePicker = element<HTMLLabelElement>('voice-picker');
  readonly endButton = element<HTMLButtonElement>('end-button');
  readonly banner = element<HTMLDivElement>('banner');

  #lastRole: 'user' | 'assistant' | null = null;
  #lastBubble: HTMLDivElement | null = null;

  showLogin(): void {
    this.loginView.hidden = false;
    this.appView.hidden = true;
  }

  showApp(): void {
    this.loginView.hidden = true;
    this.appView.hidden = false;
  }

  setState(state: AppState): void {
    this.statusText.textContent = STATUS_TEXT[state];
    this.statusDot.dataset.state = state;
    this.talkButton.dataset.state = state;

    const active = state === 'listening';
    this.talkButton.classList.toggle('is-active', active);
    this.talkButton.setAttribute('aria-pressed', String(active));
  }

  setTalkLabel(label: string): void {
    this.talkLabel.textContent = label;
  }

  setMuted(muted: boolean): void {
    this.muteButton.textContent = muted ? 'Unmute' : 'Mute';
    this.muteButton.classList.toggle('is-active', muted);
    this.muteButton.setAttribute('aria-pressed', String(muted));
  }

  setMode(mode: 'push_to_talk' | 'hands_free'): void {
    this.modeButton.textContent = mode === 'hands_free' ? 'Hands-free' : 'Hold to talk';
  }

  setVoiceOptions(
    options: Array<{ value: string; label: string }>,
    selected: string,
  ): void {
    this.voiceSelect.replaceChildren();
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      this.voiceSelect.append(node);
    }
    this.voiceSelect.value = selected;
    // One voice is not a choice — hide the control rather than show it disabled.
    this.voicePicker.hidden = options.length <= 1;
  }

  showBanner(message: string, tone: 'error' | 'info' = 'error'): void {
    this.banner.textContent = message;
    this.banner.dataset.tone = tone;
    this.banner.hidden = false;
  }

  hideBanner(): void {
    this.banner.hidden = true;
  }

  /**
   * Append or extend a transcript line.
   *
   * Consecutive deltas from the same speaker extend the current bubble rather
   * than creating one per token.
   */
  appendTranscript(role: 'user' | 'assistant', text: string, replace = false): void {
    if (!text) return;

    if (this.#lastRole !== role || !this.#lastBubble) {
      const bubble = document.createElement('div');
      bubble.className = `bubble bubble--${role}`;
      bubble.textContent = text;
      this.transcript.append(bubble);
      this.#lastRole = role;
      this.#lastBubble = bubble;
    } else if (replace) {
      this.#lastBubble.textContent = text;
    } else {
      this.#lastBubble.textContent = (this.#lastBubble.textContent ?? '') + text;
    }

    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  /** Force the next transcript update into a new bubble. */
  breakTranscript(): void {
    this.#lastRole = null;
    this.#lastBubble = null;
  }

  addSystemNote(text: string): void {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = text;
    this.transcript.append(note);
    this.transcript.scrollTop = this.transcript.scrollHeight;
    this.breakTranscript();
  }

  clearTranscript(): void {
    this.transcript.replaceChildren();
    this.breakTranscript();
  }
}
