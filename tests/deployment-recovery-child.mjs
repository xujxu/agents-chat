import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { fixtureRuntime } from './deployment-fixture.mjs';

const [control, project, operationId, manifestSha256] = process.argv.slice(2);
try {
  const saved = await verifyRecoveryEngine({ control, manifestSha256 });
  const { recoverRetirement } = await import(pathToFileURL(path.join(saved.directory, 'retirement-recovery.mjs')));
  const unlink = fs.unlink;
  fs.unlink = async file => {
    await unlink(file);
    if (path.dirname(file) === path.join(control, 'worker-engine')) {
      process.send({ deleted: path.basename(file) });
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  };
  syncBuiltinESMExports();
  await recoverRetirement({ control, project, operationId, ...fixtureRuntime() });
  throw new Error('Recovery fixture unexpectedly completed.');
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}
