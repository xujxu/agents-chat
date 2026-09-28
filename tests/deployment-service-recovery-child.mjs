import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';

const [control, project, operationId, manifestSha256, pause = 'service'] = process.argv.slice(2);
try {
  const saved = await verifyRecoveryEngine({ control, manifestSha256 });
  const stop = async deleted => {
    process.send({ deleted });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
  const open = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    const target = pause === 'lease' ? path.join(control, 'recovery-lock', 'owner.json')
      : pause === 'pending' ? path.join(control, 'recovery-complete.pending') : null;
    if (file === target && args[0] === 'wx') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); await stop(file); };
    }
    return handle;
  };
  const unlink = fs.unlink;
  fs.unlink = async file => {
    await unlink(file);
    const targets = {
      service: path.join(control, 'service-activation.ndjson'),
      marker: path.join(control, 'service-retirement.json'),
      'worker-marker': path.join(control, 'worker-retirement.json'),
      'lock-owner': path.join(control, 'lock', 'owner.json'),
      'guard-owner': path.join(control, 'recovery-lock', 'owner.json'),
    };
    if (pause === 'worker' ? path.dirname(file) === path.join(control, 'worker-engine')
      : file === targets[pause]) await stop(file);
  };
  const rmdir = fs.rmdir;
  fs.rmdir = async file => {
    await rmdir(file);
    if (pause === 'lock-directory' && file === path.join(control, 'lock')
      || pause === 'guard-directory' && file === path.join(control, 'recovery-lock')) await stop(file);
  };
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    await rename(from, to);
    if (pause === 'completion' && to === path.join(control, 'recovery-complete.json')) await stop(to);
  };
  syncBuiltinESMExports();
  const { recoverLinuxServiceRetirement } = await import(pathToFileURL(path.join(saved.directory, 'linux-service-recovery.mjs')));
  await recoverLinuxServiceRetirement({ control, project, operationId });
  throw new Error('Recovery unexpectedly completed without pausing.');
} catch (error) {
  process.stderr.write(`${error.stack}\n${error.cause?.stack ?? ''}\n`);
  process.exitCode = 1;
}
