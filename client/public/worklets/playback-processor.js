/**
 * Playback worklet — a ring buffer fed by the main thread.
 *
 * Why a ring buffer rather than scheduling an AudioBufferSourceNode per chunk:
 * chained sources leave audible clicks at chunk boundaries and drift when
 * chunks arrive late. A continuously running processor reading from a shared
 * buffer produces gapless output and degrades to silence (not distortion) when
 * the network stalls.
 */

const RING_CAPACITY = 24000 * 30; // 30 s of 24 kHz mono headroom

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = new Float32Array(RING_CAPACITY);
    this._read = 0;
    this._write = 0;
    this._available = 0;
    this._draining = false;

    this.port.onmessage = (event) => {
      const message = event.data;

      if (message?.type === 'audio') {
        this._enqueue(message.payload);
        return;
      }

      // Barge-in: drop everything queued so the assistant stops mid-word.
      if (message?.type === 'clear') {
        this._read = 0;
        this._write = 0;
        this._available = 0;
        this._draining = false;
        this.port.postMessage({ type: 'cleared' });
      }
    };
  }

  _enqueue(pcm16) {
    for (let i = 0; i < pcm16.length; i += 1) {
      if (this._available === RING_CAPACITY) break; // overflow: drop the tail
      this._ring[this._write] = pcm16[i] / 0x8000;
      this._write = (this._write + 1) % RING_CAPACITY;
      this._available += 1;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    for (let i = 0; i < output.length; i += 1) {
      if (this._available > 0) {
        output[i] = this._ring[this._read];
        this._read = (this._read + 1) % RING_CAPACITY;
        this._available -= 1;
      } else {
        output[i] = 0;
      }
    }

    // Tell the main thread when playback runs dry so the UI can drop out of
    // its "speaking" state without polling.
    const nowDraining = this._available === 0;
    if (nowDraining !== this._draining) {
      this._draining = nowDraining;
      this.port.postMessage({ type: nowDraining ? 'idle' : 'playing' });
    }

    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
