#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { models, selectVoiceAction, updateVoiceEnvironment, voiceValues } from './voice/setup-config.mjs';
import { installVoicePackage } from './voice/install-package.mjs';
import { atomicWrite, decodeEnvironment, encodeEnvironment, optionalRead, previousReceiptBytes } from './voice/configuration-files.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const equalBytes = (left, right) => left === null ? right === null : right !== null && left.equals(right);

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--non-interactive' || name === '--help') options[name.slice(2)] = true;
    else if (['--project-dir', '--model', '--package-dir', '--manifest-sha256', '--threads', '--receipt', '--rollback-receipt'].includes(name)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}.`);
      if (Object.hasOwn(options, name.slice(2))) throw new Error(`Duplicate option ${name}.`);
      options[name.slice(2)] = args[++i];
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (options.threads !== undefined && !/^(1|2|4)$/.test(options.threads)) throw new Error('Threads must be 1, 2 or 4.');
  return options;
}

async function choose() {
  console.log('1) Keep current settings (default; fresh installations remain disabled)');
  console.log(`2) ${models['sensevoice-small-q8'].label}\n   ${models['sensevoice-small-q8'].description}`);
  console.log(`3) ${models['whisper-base-q5_1'].label}\n   ${models['whisper-base-q5_1'].description}`);
  console.log('4) Disable voice input (hide microphone button)');
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    console.log('This platform does not support the native packages. Only keep/disable is available.');
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    reader.once('close', () => resolve(null));
    reader.once('SIGINT', () => reader.close());
    reader.question('Voice setup [1]: ', answer => { resolve(answer.trim()); reader.close(); });
  });
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/configure-voice.mjs [--model keep|disabled|sensevoice-small-q8|whisper-base-q5_1] [--non-interactive]');
    console.log('Enable with a trusted verified package: --package-dir DIR --manifest-sha256 SHA256 [--threads 1|2|4]');
    console.log('Configuration is applied on app restart/page reload. No services are started by this command.');
    return;
  }
  const project = path.resolve(options['project-dir'] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (/[$\r\n\0]/.test(project)) throw new Error('Project path contains unsupported environment characters.');
  const file = path.join(project, '.env.local');
  const original = await optionalRead(file);
  const originalText = decodeEnvironment(original);
  const known = voiceValues(originalText);
  console.log(`Project voice setting: ${known.VOICE_ENABLED === '1' ? 'enabled' : 'disabled or not configured'} (service overrides may differ).`);
  if (known.VOICE_ENABLED === '1') {
    const model = known.VOICE_MODEL ?? 'whisper-base-q5_1';
    console.log(`Current model: ${Object.hasOwn(models, model) ? model : 'unrecognized (preserved by keep)'}.`);
    console.log(`Policy: ${known.VOICE_RESOURCE_POLICY === 'standard' || (!known.VOICE_RESOURCE_POLICY && known.VOICE_MODEL)
      ? 'standard' : 'legacy or custom (preserved by keep)'}.`);
  }
  console.log('Reconfigure later: node scripts/configure-voice.mjs');
  let selection = selectVoiceAction({ interactive: !options['non-interactive'] && !!process.stdin.isTTY && !!process.stdout.isTTY, model: options.model });
  if (!options['rollback-receipt'] && selection.prompt) {
    selection = selectVoiceAction({ interactive: true, answer: await choose() });
  }
  if (!options['rollback-receipt'] && selection.model === 'keep') {
    if (options.receipt) await atomicWrite(path.resolve(options.receipt), JSON.stringify({ changed: false }));
    console.log('Voice configuration unchanged.');
    return;
  }
  const directory = path.join(project, '.data', 'voice');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = path.join(directory, 'setup.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another setup is active, or a previous setup was interrupted. Check .data/voice/setup.lock before retrying.');
    throw error;
  }
  try {
    if (options['rollback-receipt']) {
      const receipt = JSON.parse(decodeEnvironment(await optionalRead(path.resolve(options['rollback-receipt']))));
      if (receipt.changed === false) return;
      const previous = previousReceiptBytes(receipt);
      if (receipt.file !== file || typeof receipt.installedSha !== 'string'
        || digest(await optionalRead(file) ?? '') !== receipt.installedSha) throw new Error('Rollback refused: configuration changed after setup.');
      if (previous === null) await rm(file);
      else await atomicWrite(file, previous);
      console.log('Previous voice configuration restored; restart the app to apply it.');
      return;
    }
    const wanted = selection.model === 'disabled' ? { VOICE_ENABLED: '0' } : {
      VOICE_ENABLED: '1', VOICE_MODEL: selection.model, VOICE_RESOURCE_POLICY: 'standard',
    };
    for (const [name, values] of [
      ['inherited environment', process.env],
      ['.env.production.local', voiceValues(decodeEnvironment(await optionalRead(path.join(project, '.env.production.local'))))],
      ...(process.platform === 'linux' ? [['/etc/agents-chat.env', voiceValues(decodeEnvironment(await optionalRead('/etc/agents-chat.env')))]] : []),
    ]) {
      if (Object.keys(values).some(key => key.startsWith('VOICE_') && (
        Object.hasOwn(wanted, key) ? values[key] !== wanted[key] : selection.model !== 'disabled'
      ))) throw new Error(`Conflicting voice override in ${name}; update that source explicitly before configuring project voice.`);
    }
    const configuration = selection.model === 'disabled' ? null : await installVoicePackage({
      packageDir: options['package-dir'], manifestSha256: options['manifest-sha256'],
      model: selection.model, destination: directory,
      threads: Number(options.threads ?? models[selection.model].threads),
    });
    const next = encodeEnvironment(updateVoiceEnvironment(originalText, selection.model, configuration));
    if (!equalBytes(await optionalRead(file), original)) throw new Error('Configuration changed during setup; refusing to overwrite it.');
    const receipt = { version: 2, changed: true, file, previous: original === null ? null : original.toString('base64'), installedSha: digest(next) };
    const receiptPath = path.resolve(options.receipt ?? path.join(directory, 'last-setup.json'));
    if (receiptPath === file) throw new Error('Recovery receipt must not overwrite the environment file.');
    // Save recovery before switching configuration, never after.
    await atomicWrite(receiptPath, JSON.stringify(receipt));
    await atomicWrite(file, next);
    console.log(selection.model === 'disabled'
      ? 'Voice disabled. After restart/reload the microphone button is hidden.'
      : 'Verified voice package configured in standard mode. Restart the app to apply; this is not full release acceptance.');
  } finally { await rm(lock, { recursive: true }); }
}

run().catch(error => {
  console.error(`Voice setup failed: ${error.message}`);
  process.exitCode = 1;
});
