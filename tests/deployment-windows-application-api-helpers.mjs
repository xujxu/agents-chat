import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loginDeploymentFixture } from './deployment-http-fixture.mjs';
import { verifyHttpReadiness, waitReadiness } from '../scripts/deployment/http-readiness.mjs';

export async function verifyWindowsColdLaunchApi({ pwsh, runtime, chatId, directory }) {
  const script = fileURLToPath(new URL('./deployment-windows-cold-launch-listener.ps1', import.meta.url));
  const { stdout } = await promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-File', script,
    '-Generation', runtime.generation, '-OwnerPid', String(runtime.pid), '-OwnerIdentity', runtime.identity,
    '-LauncherPid', String(runtime.launcherPid), '-Node', process.execPath, '-ChatId', chatId],
  { cwd: directory, timeout: 270000, maxBuffer: 16384 });
  const readiness = JSON.parse(stdout);
  assert.deepEqual(readiness, { status: 'ready', generation: runtime.generation, port: 3010 });
  return readiness;
}

export async function verifyWindowsApplicationApi(mode, chatId, { waitReady = false } = {}) {
  assert.ok(['create', 'mutate', 'restored'].includes(mode), 'An explicit API fixture phase is required.');
  assert.match(chatId ?? '', /^[a-zA-Z0-9-]+$/);
  if (waitReady) {
    await waitReadiness(signal => verifyHttpReadiness({ port: 3010, providers: ['admin-login'], signal }),
      { waitSeconds: 120 });
  } else {
    await verifyHttpReadiness({ port: 3010, providers: ['admin-login'] });
  }
  const api = await loginDeploymentFixture();
  const originalName = 'Before native maintenance';
  const content = 'Managed Windows data survives restoration';
  if (mode === 'create') {
    assert.equal((await api('/api/chats', { chat: {
      id: chatId, name: originalName, ts: Date.now(), agentSessions: {},
      messages: [{ id: 'original', type: 'user', content, ts: Date.now() }],
    } })).ok, true);
  } else if (mode === 'mutate') {
    assert.equal((await api(`/api/chats?id=${chatId}`)).chat.name, originalName);
    assert.equal((await api('/api/chats', {
      action: 'rename', chatId, name: 'After native maintenance',
    })).ok, true);
  }
  const chat = (await api(`/api/chats?id=${chatId}`)).chat;
  assert.equal(chat.name, mode === 'mutate' ? 'After native maintenance' : originalName);
  assert.equal(chat.messages[0].content, content);
}
