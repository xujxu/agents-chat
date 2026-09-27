import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [launcher, fixture, treeFile, parentFile] = process.argv.slice(2);
const child = spawn(launcher, ['120000', process.execPath, fixture, 'tree', treeFile], {
  stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
});
child.once('error', () => process.exit(9));
child.once('spawn', () => writeFileSync(parentFile, JSON.stringify({ launcher: child.pid })));
setInterval(() => {}, 1000);
