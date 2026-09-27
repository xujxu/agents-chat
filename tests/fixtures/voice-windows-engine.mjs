import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, file, ...values] = process.argv.slice(2);
if (mode === 'args') {
  process.stdout.write(JSON.stringify([file, ...values]));
} else if (mode === 'exit') {
  process.stderr.write('private native diagnostic');
  process.exitCode = Number(file);
} else if (mode === 'leaf') {
  setInterval(() => {}, 1000);
} else if (mode === 'nested') {
  const child = spawn(file, ['5000', ...values], {
    stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
  });
  child.once('error', () => process.exit(9));
  child.once('close', code => { process.exitCode = code ?? 9; });
} else if (mode === 'tree' || mode === 'tree-exit') {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), 'leaf',
  ], { stdio: 'ignore', windowsHide: true });
  child.once('error', () => process.exit(9));
  child.once('spawn', () => {
    writeFileSync(file, JSON.stringify({ engine: process.pid, descendant: child.pid }));
    if (mode === 'tree-exit') {
      child.unref();
      process.stdout.write('completed');
    } else {
      setInterval(() => {}, 1000);
    }
  });
} else {
  process.exitCode = 10;
}
