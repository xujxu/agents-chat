import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';

const [control, project, operationId, manifestSha256] = process.argv.slice(2);
try {
  const saved = await verifyRecoveryEngine({ control, manifestSha256 });
  const unlink = fs.unlink;
  fs.unlink = async file => {
    await unlink(file);
    if (file === path.join(control, 'service-activation.ndjson')) {
      process.send({ deleted: file });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  };
  syncBuiltinESMExports();
  const { recoverLinuxServiceRetirement } = await import(pathToFileURL(path.join(saved.directory, 'linux-service-recovery.mjs')));
  await recoverLinuxServiceRetirement({ control, project, operationId });
  throw new Error('Recovery unexpectedly completed without pausing.');
} catch (error) {
  process.stderr.write(`${error.stack}\n${error.cause?.stack ?? ''}\n`);
  process.exitCode = 1;
}
