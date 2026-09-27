import { test } from '@playwright/test';
import { lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function snapshot() {
  const names = (await readdir(tmpdir())).filter(name => name.startsWith('agents-chat-voice-')).sort();
  const directories = [];
  for (const name of names.slice(0, 64)) {
    const directory = path.join(tmpdir(), name);
    try {
      const info = await lstat(directory);
      const members = info.isDirectory() ? (await readdir(directory)).sort() : [];
      const files = [];
      for (const member of members.slice(0, 20)) {
        try {
          const item = await lstat(path.join(directory, member));
          files.push({ name: member, bytes: item.size, directory: item.isDirectory(), symlink: item.isSymbolicLink() });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          files.push({ name: member, removedDuringSnapshot: true });
        }
      }
      directories.push({ name, createdAt: info.birthtime.toISOString(), modifiedAt: info.mtime.toISOString(),
        memberCount: members.length, files });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      directories.push({ name, removedDuringSnapshot: true });
    }
  }
  return { count: names.length, directories };
}

export function registerVoiceCleanupDiagnostics() {
  if (process.env.VOICE_CLEANUP_DIAGNOSTICS !== '1') return;
  // Observe without retrying, deleting files, or changing the suite's leak assertion.
  test.beforeEach(async ({}, info) => {
    console.log('VOICE_CLEANUP_DIAGNOSTIC', JSON.stringify({
      phase: 'before', test: info.title, observedAt: new Date().toISOString(), ...await snapshot(),
    }));
  });
  test.afterEach(async ({}, info) => {
    console.log('VOICE_CLEANUP_DIAGNOSTIC', JSON.stringify({
      phase: 'after', test: info.title, observedAt: new Date().toISOString(), ...await snapshot(),
    }));
  });
}
