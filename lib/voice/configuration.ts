import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { VoiceError } from './audio';

export const VOICE_MODELS = {
  'whisper-base-q5_1': { provider: 'whisper', apiModel: 'base-q5_1', defaultThreads: 1 },
  'sensevoice-small-q8': { provider: 'sensevoice-gguf', apiModel: 'sensevoice-small-q8', defaultThreads: 2 },
} as const;

export type VoiceModelId = keyof typeof VOICE_MODELS;
export type VoiceResourcePolicy = 'standard' | 'legacy-low-memory';
export type VoiceConfiguration = {
  platform: 'linux' | 'win32';
  launcher?: string;
  binary: string;
  model: string;
  modelId: VoiceModelId;
  provider: (typeof VOICE_MODELS)[VoiceModelId]['provider'];
  threads: number;
  resourcePolicy: VoiceResourcePolicy;
};
type Environment = Readonly<Record<string, string | undefined>>;

function windowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) && path.win32.isAbsolute(value)
    && !/[:\0]/.test(value.slice(2));
}

export function parseVoiceConfiguration(
  env: Environment, platform: string = process.platform, architecture: string = process.arch,
): VoiceConfiguration | null {
  if (env.VOICE_ENABLED === undefined || env.VOICE_ENABLED === '0') return null;
  if (env.VOICE_ENABLED !== '1' || (platform !== 'linux' && platform !== 'win32') || architecture !== 'x64') {
    throw new VoiceError('voice_not_configured', 503);
  }
  const explicitModel = env.VOICE_MODEL !== undefined;
  const modelId = env.VOICE_MODEL ?? 'whisper-base-q5_1';
  if (modelId !== 'whisper-base-q5_1' && modelId !== 'sensevoice-small-q8') {
    throw new VoiceError('voice_not_configured', 503);
  }
  const definition = VOICE_MODELS[modelId];
  const binary = env.VOICE_BINARY_PATH ?? (definition.provider === 'whisper' ? env.VOICE_WHISPER_PATH : undefined);
  const model = env.VOICE_MODEL_PATH;
  const launcher = platform === 'win32' ? env.VOICE_LAUNCHER_PATH : undefined;
  const resourcePolicy = env.VOICE_RESOURCE_POLICY ?? (explicitModel ? 'standard' : 'legacy-low-memory');
  const threads = env.VOICE_THREADS === undefined ? definition.defaultThreads : Number(env.VOICE_THREADS);
  const absolute = platform === 'win32' ? windowsPath : path.posix.isAbsolute;
  if (!binary || !model || !absolute(binary) || !absolute(model)
    || binary.includes('\0') || model.includes('\0')
    || (platform === 'win32' && (!explicitModel || resourcePolicy !== 'standard'
      || !launcher || !windowsPath(launcher) || !/\.exe$/i.test(launcher) || !/\.exe$/i.test(binary)))
    || (env.VOICE_THREADS !== undefined && !/^(1|2|4)$/.test(env.VOICE_THREADS))
    || (resourcePolicy !== 'standard' && resourcePolicy !== 'legacy-low-memory')
    || (resourcePolicy === 'legacy-low-memory' && (modelId !== 'whisper-base-q5_1' || threads !== 1))) {
    throw new VoiceError('voice_not_configured', 503);
  }
  return { platform, ...(launcher ? { launcher } : {}), binary, model, modelId, provider: definition.provider, threads, resourcePolicy };
}

export async function voiceConfiguration(env: Environment = process.env): Promise<VoiceConfiguration | null> {
  const config = parseVoiceConfiguration(env);
  if (!config) return null;
  try {
    const paths = [config.binary, config.model];
    if (config.platform === 'win32') {
      if (!config.launcher) throw new VoiceError('voice_not_configured', 503);
      paths.push(config.launcher);
      await Promise.all(paths.map(file => access(file, constants.R_OK)));
    } else {
      await Promise.all([
        access(config.binary, constants.X_OK), access(config.model, constants.R_OK),
        access('/usr/bin/prlimit', constants.X_OK), access('/usr/bin/nice', constants.X_OK),
      ]);
    }
    const files = await Promise.all(paths.map(file => stat(file)));
    if (files.some(file => !file.isFile())) throw new VoiceError('voice_not_configured', 503);
  } catch {
    // Do not expose native filesystem paths in an API error.
    throw new VoiceError('voice_not_configured', 503);
  }
  return config;
}

export function voiceCapabilities(config: VoiceConfiguration | null) {
  return {
    enabled: config !== null,
    model: config ? VOICE_MODELS[config.modelId].apiModel : null,
    provider: config?.provider ?? null,
    threads: config?.threads ?? null,
    resourcePolicy: config?.resourcePolicy ?? null,
  };
}

export function legacyVoiceConfiguration(paths: { binary: string; model: string }): VoiceConfiguration {
  return { ...paths, platform: 'linux', modelId: 'whisper-base-q5_1', provider: 'whisper', threads: 1, resourcePolicy: 'legacy-low-memory' };
}
