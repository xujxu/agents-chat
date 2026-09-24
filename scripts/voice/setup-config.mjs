export const models = {
  'sensevoice-small-q8': {
    label: 'SenseVoiceSmall official GGUF q8 (integration candidate)',
    threads: 2,
    modelSha256: '4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5',
    description: 'Apache-2.0 weights; MIT engine. Measured ~357 MiB process RSS; 2 threads. Tested 2CPU/4GiB allocation is NOT a minimum or imposed limit.',
  },
  'whisper-base-q5_1': {
    label: 'Whisper base-q5_1 (compatibility, not recommended quality/latency)',
    threads: 1,
    modelSha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    description: 'MIT weights/code, GCC runtime exception obligations. Measured ~153 MiB process RSS in prior low-budget test; 1 thread. Failed interaction gates.',
  },
};

const voiceKey = /^\s*(?:export\s+)?(VOICE_(?:ENABLED|MODEL|WHISPER_PATH|BINARY_PATH|LAUNCHER_PATH|MODEL_PATH|THREADS|RESOURCE_POLICY))\s*=/;
export function voiceValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(voiceKey);
    if (!match) continue;
    let value = line.slice(match[0].length).trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); }
      catch { throw new Error('Unsupported voice environment quoting; use one KEY=value per line.'); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error('Multiline voice environment values are unsupported.');
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/, '').trim();
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid voice environment value.');
    values[match[1]] = value;
  }
  return values;
}

export function selectVoiceAction({ interactive, model, answer }) {
  if (model !== undefined) {
    if (model !== 'keep' && model !== 'disabled' && !Object.hasOwn(models, model)) throw new Error('Unsupported voice model.');
    return { prompt: false, model };
  }
  if (!interactive) return { prompt: false, model: 'keep' };
  if (answer === undefined) return { prompt: true, model: 'keep' };
  const selected = { '': 'keep', '1': 'keep', '2': 'sensevoice-small-q8', '3': 'whisper-base-q5_1', '4': 'disabled' }[answer ?? ''];
  if (!selected) throw new Error('Invalid selection.');
  return { prompt: false, model: selected };
}

export function updateVoiceEnvironment(original, model, configuration) {
  if (model === 'keep') return original;
  if (model !== 'disabled' && !Object.hasOwn(models, model)) throw new Error('Unsupported voice model.');
  voiceValues(original);
  const lines = original.split(/\r?\n/).filter(line => !voiceKey.test(line));
  while (lines.at(-1) === '') lines.pop();
  const configPath = value => configuration?.launcher && typeof value === 'string' ? value.replaceAll('\\', '/') : value;
  const values = model === 'disabled' ? { VOICE_ENABLED: '0' } : {
    VOICE_ENABLED: '1', VOICE_MODEL: model,
    VOICE_BINARY_PATH: configPath(configuration?.binary), VOICE_MODEL_PATH: configPath(configuration?.model),
    ...(configuration?.launcher ? { VOICE_LAUNCHER_PATH: configPath(configuration.launcher) } : {}),
    VOICE_THREADS: String(configuration?.threads ?? models[model].threads),
    VOICE_RESOURCE_POLICY: 'standard',
  };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !value || /[$\r\n\0]/.test(value)
      || (configuration?.launcher && /["'\x00-\x1f]/.test(value))) throw new Error('Invalid voice configuration value.');
    lines.push(`${key}=${/^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value)}`);
  }
  return lines.join('\n') + '\n';
}
