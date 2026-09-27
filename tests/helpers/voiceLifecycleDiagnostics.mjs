import { lstat, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function boundedEvents(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid event limit');
  const events = [];
  let dropped = 0;
  return {
    push(event) { if (events.length < limit) events.push(event); else dropped++; },
    snapshot() { return { events: [...events], dropped }; },
  };
}

export async function directorySnapshot(root) {
  const names = (await readdir(root)).filter(name => name.startsWith('agents-chat-voice-')).sort();
  const directories = [];
  for (const name of names.slice(0, 64)) {
    const directory = path.join(root, name);
    try {
      const info = await lstat(directory);
      const members = info.isDirectory() && !info.isSymbolicLink() ? (await readdir(directory)).sort() : [];
      const files = [];
      for (const member of members.slice(0, 20)) {
        try {
          const item = await lstat(path.join(directory, member));
          files.push({ name: member, bytes: item.size, directory: item.isDirectory(), symlink: item.isSymbolicLink() });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          files.push({ name: member, removedDuringSnapshot: true });
        }
      }
      directories.push({ name, symlink: info.isSymbolicLink(), createdAt: info.birthtime.toISOString(),
        modifiedAt: info.mtime.toISOString(), memberCount: members.length, files });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      directories.push({ name, removedDuringSnapshot: true });
    }
  }
  return { count: names.length, directories };
}

export async function saveDiagnosticReport(file, report) {
  await writeFile(file, JSON.stringify(report, null, 2));
}

export function recordVoiceLifecycle(context) {
  const events = boundedEvents(4096);
  const record = (kind, details = {}) => events.push({
    observedAt: new Date().toISOString(), ...context(), kind, ...details,
  });
  return {
    record,
    snapshot() { return { ...events.snapshot(), collection: 'lifecycle-only-no-filesystem-watcher' }; },
  };
}
