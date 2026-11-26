// (0.6.452) The sound of the dictation (public/dictation.mjs): what the microphone hears, on one channel, handed to
// the page in pieces of some 40 ms with their level. Nothing is kept here: the page gathers the pieces, and only
// until the dictation ends. For « Essayer » (public/dictation-settings.mjs), the level alone (`levels`).
// What is heard here is never read back from Web Audio (an AudioBuffer, an AnalyserNode): Brave, in its strict
// protection, gives noise back from those.
// A multiple of the 128 samples the browser hands at a time: 2048 at 48 kHz, 640 at 16 kHz.
const PIECE = 128 * Math.max(1, Math.round(sampleRate / 3000));

class DictationSound extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.levels = Boolean(options?.processorOptions?.levels);
    this.piece = new Float32Array(PIECE);
    this.filled = 0;
    this.open = true;
    // « flush »: the dictation ends. What is left goes, then the word that all of it went.
    this.port.onmessage = ({ data }) => {
      if (data !== 'flush' || !this.open) return;
      this.send();
      this.open = false;
      this.port.postMessage({ done: true });
    };
  }
  send() {
    if (!this.filled) return;
    let sum = 0;
    for (let index = 0; index < this.filled; index++) sum += this.piece[index] * this.piece[index];
    const level = Math.sqrt(sum / this.filled);
    if (this.levels) this.port.postMessage({ level });
    else {
      const samples = this.piece.slice(0, this.filled);
      this.port.postMessage({ samples, level }, [samples.buffer]);
    }
    this.filled = 0;
  }
  process(inputs) {
    if (!this.open) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const length = channels[0].length;
    for (let index = 0; index < length; index++) {
      let value = 0;
      for (const channel of channels) value += channel[index];
      this.piece[this.filled++] = value / channels.length;
      if (this.filled === PIECE) this.send();
    }
    return true;
  }
}

registerProcessor('moodix-dictation', DictationSound);
