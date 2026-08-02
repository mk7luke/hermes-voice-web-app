/**
 * Microphone capture worklet.
 *
 * Runs on the audio thread. Converts Float32 input to PCM16 and posts it to the
 * main thread in ~40 ms batches.
 *
 * Batching matters: `process()` fires every 128 frames (about 5 ms at 24 kHz),
 * and posting a message that often floods the main thread and produces a
 * WebSocket frame per 5 ms of audio. 40 ms is small enough to stay responsive
 * and large enough to keep message traffic sane.
 */

const FRAMES_PER_BATCH = 960; // 40 ms at 24 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(FRAMES_PER_BATCH);
    this._offset = 0;
    this._muted = false;

    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') {
        this._muted = Boolean(event.data.muted);
        // Drop anything half-captured so unmuting does not replay stale audio.
        this._offset = 0;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    if (this._muted) return true;

    for (let i = 0; i < channel.length; i += 1) {
      // Clamp before scaling: values outside [-1, 1] would wrap and turn a
      // loud sound into loud noise.
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this._offset += 1;

      if (this._offset === FRAMES_PER_BATCH) {
        // Copy before transferring — the buffer is reused for the next batch.
        const batch = this._buffer.slice();
        this.port.postMessage({ type: 'audio', payload: batch }, [batch.buffer]);
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
