import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureOwner } from './worker-identity.mjs';
import { verifyWorkerEngine } from './saved-worker-engine.mjs';

try {
  const [control, manifestSha256, ...extra] = process.argv.slice(2);
  if (!control || !manifestSha256 || extra.length) throw new Error('Invalid inspection arguments.');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32768) throw new Error('Inspection input exceeds limit.');
    chunks.push(chunk);
  }
  const owner = captureOwner(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  const saved = await verifyWorkerEngine({
    control, project: owner.project, operationId: owner.operationId, manifestSha256,
  });
  if (fileURLToPath(import.meta.url) !== saved.entrypoint) throw new Error('Wrong saved inspection entrypoint.');
  const { readWorkerJournal } = await import(pathToFileURL(path.join(saved.directory, 'worker-journal.mjs')));
  const receipts = await readWorkerJournal(control, owner);
  process.stdout.write(`${JSON.stringify({
    status: 'inspection-only', phase: receipts.at(-1).phase, recoveryAuthorized: false,
  })}\n`);
} catch {
  process.stderr.write('Saved worker inspection failed; retain the engine, journal, lock and backup. No recovery was authorized.\n');
  process.exitCode = 1;
}
