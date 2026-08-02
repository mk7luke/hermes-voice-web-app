/**
 * Microphone capture and speaker playback.
 *
 * One AudioContext drives both worklets. It is created lazily on the first user
 * gesture because iOS Safari will not start an AudioContext otherwise — this is
 * why the talk button, not page load, initialises audio.
 */

export interface AudioEngineOptions {
  sampleRate: number;
  /** Called with PCM16 frames captured from the microphone. */
  onAudio: (pcm16: Int16Array) => void;
  /** Called when playback starts or stops, for UI state. */
  onPlaybackStateChange?: (speaking: boolean) => void;
}

export class AudioEngine {
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #capture: AudioWorkletNode | null = null;
  #playback: AudioWorkletNode | null = null;
  #muted = false;

  readonly #options: AudioEngineOptions;

  constructor(options: AudioEngineOptions) {
    this.#options = options;
  }

  get ready(): boolean {
    return this.#context !== null;
  }

  /** Idempotent. Safe to call on every talk-button press. */
  async init(): Promise<void> {
    if (this.#context) {
      // Browsers suspend the context when a tab is backgrounded.
      if (this.#context.state === 'suspended') await this.#context.resume();
      return;
    }

    const context = new AudioContext({ sampleRate: this.#options.sampleRate });
    await context.audioWorklet.addModule('/worklets/capture-processor.js');
    await context.audioWorklet.addModule('/worklets/playback-processor.js');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation is what makes barge-in usable on a phone speaker;
        // without it the model hears itself and interrupts its own answer.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'capture-processor');
    capture.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; payload?: Int16Array };
      if (message.type === 'audio' && message.payload) {
        this.#options.onAudio(message.payload);
      }
    };

    // A worklet only runs while connected to the graph. Route capture through a
    // silent gain node so it processes without being audible to the user.
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(capture).connect(sink).connect(context.destination);

    const playback = new AudioWorkletNode(context, 'playback-processor', {
      outputChannelCount: [1],
    });
    playback.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string };
      if (message.type === 'playing') this.#options.onPlaybackStateChange?.(true);
      if (message.type === 'idle') this.#options.onPlaybackStateChange?.(false);
    };
    playback.connect(context.destination);

    if (context.state === 'suspended') await context.resume();

    this.#context = context;
    this.#stream = stream;
    this.#source = source;
    this.#capture = capture;
    this.#playback = playback;
    this.#applyMute();
  }

  /** Queue assistant audio for gapless playback. */
  play(pcm16: Int16Array): void {
    // Transferring detaches the buffer, so hand over a copy — callers may still
    // hold a reference to the decoded chunk.
    const copy = pcm16.slice();
    this.#playback?.port.postMessage({ type: 'audio', payload: copy }, [copy.buffer]);
  }

  /** Drop queued assistant audio immediately (barge-in). */
  stopPlayback(): void {
    this.#playback?.port.postMessage({ type: 'clear' });
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#applyMute();
  }

  get muted(): boolean {
    return this.#muted;
  }

  #applyMute(): void {
    this.#capture?.port.postMessage({ type: 'mute', muted: this.#muted });
  }

  /**
   * Tear everything down and release the microphone.
   *
   * Stopping the tracks is what turns off the phone's recording indicator, so
   * this runs on session end and on page hide — leaving the mic live after the
   * user thinks they hung up would be a genuine privacy failure.
   */
  async close(): Promise<void> {
    this.stopPlayback();
    this.#capture?.port.close();
    this.#playback?.port.close();
    this.#source?.disconnect();
    this.#capture?.disconnect();
    this.#playback?.disconnect();
    this.#stream?.getTracks().forEach((track) => track.stop());

    if (this.#context && this.#context.state !== 'closed') {
      await this.#context.close();
    }

    this.#context = null;
    this.#stream = null;
    this.#source = null;
    this.#capture = null;
    this.#playback = null;
  }
}

/** PCM16 → base64, for `input_audio_buffer.append`. */
export function pcm16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  let binary = '';
  // Chunked to stay under the argument-count limit of String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → PCM16, for assistant audio deltas. */
export function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  // The byte length is always even for PCM16, but guard anyway: a truncated
  // frame would otherwise throw inside the Int16Array constructor.
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  return new Int16Array(bytes.buffer, 0, usable / 2);
}
