export const graphStimuli = ['mono-tones', 'mono-markers', 'stereo-tones'] as const;
export type GraphStimulus = typeof graphStimuli[number];
export type GraphMode = 'minimal' | 'full';
export const graphSchedule = graphStimuli.flatMap(stimulus => [0, 1, 2].flatMap(repeat =>
  (repeat === 1 ? ['full', 'minimal'] as const : ['minimal', 'full'] as const)
    .map(mode => ({ stimulus, repeat, mode }))));

export function graphWav(stimulus: GraphStimulus): Buffer {
  const channels = stimulus === 'stereo-tones' ? 2 : 1;
  const frames = 128000;
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000 * channels, 28);
  bytes.writeUInt16LE(2 * channels, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const chips = [1, 2, 3].map(seed => {
    let state = seed >>> 0;
    return Array.from({ length: 40 }, () => {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      return state & 1 ? .12 : .04;
    });
  });
  for (let i = 0; i < frames; i++) {
    const time = i / 16000;
    for (let channel = 0; channel < channels; channel++) {
      let value = 0;
      if (stimulus === 'mono-markers') {
        for (let index = 0; index < 3; index++) {
          const relative = i - (1 + index * 3) * 16000;
          if (relative >= 0 && relative < 3200) {
            value = chips[index][Math.floor(relative / 80)] * Math.sin(2 * Math.PI * 1000 * time);
          }
        }
      } else if (time >= .5 && time < 7.5) {
        value = stimulus === 'mono-tones'
          ? [250, 1000, 3000].reduce((sum, frequency) => sum + .04 * Math.sin(2 * Math.PI * frequency * time), 0)
          : (channel ? .06 : .10) * Math.sin(2 * Math.PI * (channel ? 1500 : 500) * time);
      }
      bytes.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + (i * channels + channel) * 2);
    }
  }
  return bytes;
}
