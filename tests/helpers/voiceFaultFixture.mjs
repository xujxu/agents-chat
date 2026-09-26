import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { promisify } from 'node:util';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

export const faultModes = [
  'normal', 'cancel', 'cancel-cleanup-failure', 'cleanup-failure',
  'create-before-failure', 'create-after-failure',
];
const sourceIds = [
  'app/api/voice/route.ts', 'lib/voice/transcriber.ts', 'lib/voice/windowsNative.ts',
  'lib/voice/jobs.ts', 'lib/voice/audio.ts',
];

export async function createVoiceFaultFixture() {
  const directories = new Set();
  const timers = new Map();
  const modules = new Map();
  const sourceHashes = {};
  let mode = 'normal';
  let requestId = '';
  let serial = 0;
  let timerId = 0;
  let events = [];
  let logCodes = [];
  let violations = [];
  const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const root = 'C:\\fixture-private';
  const config = {
    platform: 'win32', launcher: `${root}\\launcher.exe`, binary: `${root}\\engine.exe`,
    model: `${root}\\model`, modelId: 'sensevoice-small-q8', provider: 'sensevoice-gguf',
    threads: 2, resourcePolicy: 'standard',
  };
  const guard = (condition, label) => {
    if (!condition) { violations.push(label); throw new Error(`Fixture boundary violation: ${label}`); }
  };
  const owned = directory => guard(directories.has(directory), 'unowned-directory');
  const context = createContext({
    Error, TypeError, Buffer, AbortController, TextEncoder, TextDecoder, URL,
    performance, console,
    process: { env: { SystemRoot: 'C:\\Windows' }, platform: 'win32', arch: 'x64' },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const mocked = {
    'node:crypto': { randomUUID: uuid },
    'node:os': { tmpdir: () => root },
    'node:path': { default: path.win32 },
    'node:util': { promisify },
    'node:child_process': {
      execFile(binary, args, options, callback) {
        guard(binary === config.launcher && args.length === 2 && args[0] === '--create-directory',
          'unexpected-native-operation');
        const directory = args[1];
        guard(path.win32.dirname(directory) === root
          && /^agents-chat-voice-[0-9a-f-]{36}$/.test(path.win32.basename(directory)), 'invalid-directory');
        guard(options.env.TEMP === root && options.windowsHide === true, 'invalid-helper-options');
        events.push('create:start');
        if (mode === 'create-before-failure') {
          events.push('create:injected-failure');
          callback(new Error('fixture-private helper failure'));
          return;
        }
        guard(!directories.has(directory), 'duplicate-directory');
        directories.add(directory);
        events.push('create:owned');
        if (mode === 'create-after-failure') {
          events.push('create:injected-failure');
          callback(new Error('fixture-private helper failure'));
          return;
        }
        callback(null, Buffer.alloc(0), Buffer.alloc(0));
      },
    },
    'node:fs/promises': {
      async mkdtemp() { guard(false, 'unexpected-linux-directory'); },
      async writeFile(file, audio, options) {
        owned(path.win32.dirname(file));
        guard(path.win32.basename(file) === 'audio.wav' && audio.byteLength > 44, 'invalid-audio-write');
        options.signal.throwIfAborted();
        events.push('audio:written');
      },
      async rm(directory, options) {
        owned(directory);
        guard(options.recursive === true && options.force === true, 'invalid-cleanup-options');
        events.push('cleanup:attempt');
        if (mode === 'cleanup-failure' || mode === 'cancel-cleanup-failure') {
          events.push('cleanup:injected-EPERM');
          throw Object.assign(new Error('fixture-private cleanup failure'), { code: 'EPERM' });
        }
        directories.delete(directory);
        events.push('cleanup:complete');
      },
    },
    'next/server': {
      NextResponse: { json: (body, options) => ({ body, status: options.status }) },
    },
    'lib/auth.ts': { getAuthToken: async () => ({ email: 'fixture-user' }) },
    'lib/logger.ts': {
      createLogger: () => ({
        warn(fields) {
          guard(fields && typeof fields.code === 'string', 'unexpected-warning-shape');
          logCodes.push(fields.code);
        },
        info: () => {},
      }),
    },
    'lib/voice/configuration.ts': {
      voiceConfiguration: async () => config,
      legacyVoiceConfiguration() { guard(false, 'unexpected-legacy-config'); },
      voiceCapabilities() { guard(false, 'unexpected-capabilities'); },
    },
    'lib/voice/memory.ts': {
      async assertVoiceMemoryAvailable() { guard(false, 'unexpected-memory-policy'); },
    },
    'lib/voice/providers.ts': {
      decodeVoiceText: () => 'fixture-private transcript',
      async readWhisperOutput() { guard(false, 'unexpected-whisper-read'); },
    },
    'lib/voice/process.ts': {
      async runVoiceProcess(configuration, input, output, signal) {
        guard(configuration === config, 'unexpected-configuration');
        owned(path.win32.dirname(input));
        guard(path.win32.dirname(input) === path.win32.dirname(output), 'invalid-output-directory');
        guard(signal instanceof AbortSignal, 'invalid-inference-signal');
        events.push('infer:start');
        if (mode === 'cancel' || mode === 'cancel-cleanup-failure') {
          modules.get('lib/voice/jobs.ts').namespace.cancelVoiceJob('fixture-user', requestId);
          guard(signal.aborted, 'cancellation-not-delivered');
          events.push('infer:cancelled');
          throw signal.reason;
        }
        return Buffer.from('fixture-private transcript');
      },
    },
  };
  for (const id of sourceIds) {
    const source = await readFile(new URL(`../../${id}`, import.meta.url), 'utf8');
    sourceHashes[id] = createHash('sha256').update(source).digest('hex');
    modules.set(id, new SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), {
      context, identifier: id,
    }));
  }
  for (const [id, exports] of Object.entries(mocked)) {
    modules.set(id, new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: id }));
  }
  const route = modules.get('app/api/voice/route.ts');
  await route.link((specifier, referencing) => {
    const id = specifier.startsWith('@/') ? `${specifier.slice(2)}.ts`
      : specifier.startsWith('.') ? `${path.posix.normalize(path.posix.join(path.posix.dirname(referencing.identifier), specifier))}.ts`
        : specifier;
    if (!modules.has(id)) throw new Error(`Unexpected voice fixture import: ${id}`);
    return modules.get(id);
  });
  await route.evaluate();
  return {
    sourceHashes,
    async request(nextMode) {
      if (!faultModes.includes(nextMode)) throw new Error('Unknown fault mode');
      mode = nextMode;
      events = []; logCodes = []; violations = [];
      requestId = uuid();
      const audio = modules.get('lib/voice/audio.ts').namespace.encodeVoiceWav(new Float32Array(16000).fill(0.2));
      const request = new Request('http://fixture.local/api/voice', {
        method: 'POST', body: audio,
        headers: { 'content-type': 'audio/wav', 'x-voice-user-id': 'fixture-user', 'x-voice-request-id': requestId },
      });
      request.nextUrl = new URL(request.url);
      const response = await route.namespace.POST(request);
      guard(violations.length === 0, 'caught-boundary-violation');
      return {
        status: response.status, code: response.body.error ?? null,
        events: [...events], logCodes: [...logCodes],
        cleanupAttempts: events.filter(event => event === 'cleanup:attempt').length,
        remainingDirectories: directories.size, pendingTimers: timers.size,
      };
    },
    dispose() { directories.clear(); timers.clear(); },
  };
}
