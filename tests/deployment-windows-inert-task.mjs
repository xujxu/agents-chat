import { execFile } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function registerInertWindowsTask({ project, taskName, pwsh }) {
  const scripts = path.join(project, 'scripts');
  const installer = path.join(scripts, 'install-scheduled-task.ps1');
  await mkdir(scripts, { recursive: true });
  await writeFile(path.join(scripts, 'service-watchdog.ps1'), 'exit 0\n');
  await copyFile(fileURLToPath(new URL('../scripts/install-scheduled-task.ps1', import.meta.url)), installer);
  await promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-File',
    installer, '-TaskName', taskName, '-ProjectDir', project], { timeout: 30000, maxBuffer: 16384 });
}
