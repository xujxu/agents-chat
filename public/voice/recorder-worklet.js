class VoiceRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.maximum = Math.floor(sampleRate * options.processorOptions.maxSeconds);
    this.total = 0;
    this.buffer = new Float32Array(2048);
    this.used = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: 'finished' });
      }
    };
  }

  flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
    this.used = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (this.stopped || !channels?.length) return true;
    for (let i = 0; i < channels[0].length && this.total < this.maximum; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.buffer[this.used++] = sample;
      this.total++;
      if (this.used === this.buffer.length) this.flush();
    }
    if (this.total >= this.maximum) {
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: 'limit' });
    }
    return true;
  }
}

registerProcessor('agents-chat-voice', VoiceRecorderProcessor);
