import { watch } from 'node:fs';
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

export function watchVoiceDirectories(root, context) {
  const events = boundedEvents(4096);
  const errors = boundedEvents(32);
  const record = (kind, details = {}) => events.push({
    observedAt: new Date().toISOString(), ...context(), kind, ...details,
  });
  let watcher;
  try {
    watcher = watch(root, (kind, filename) => {
      if (filename === null) {
        errors.push({ code: 'missing_filename', observedAt: new Date().toISOString() });
        return;
      }
      const name = filename.toString();
      if (name.startsWith('agents-chat-voice-')) record('directory-notification', { notification: kind, name });
    });
    watcher.on('error', error => errors.push({ code: error.code ?? error.name, observedAt: new Date().toISOString() }));
  } catch (error) {
    errors.push({ code: error.code ?? error.name, observedAt: new Date().toISOString() });
  }
  return {
    record,
    close() { watcher?.close(); },
    snapshot() { return { ...events.snapshot(), captureErrors: errors.snapshot() }; },
  };
}
