import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { createConnection, isIPv4 } from 'node:net';

const [mode, supplied] = process.argv.slice(2);
assert.ok(['allowed', 'blocked'].includes(mode));
const address = supplied ?? (await lookup('registry.npmjs.org', { family: 4 })).address;
assert.ok(isIPv4(address));
const result = await new Promise(resolve => {
  const socket = createConnection({ host: address, port: 443 });
  socket.setTimeout(5000, () => socket.destroy(Object.assign(new Error('Egress probe timed out'), { code: 'ETIMEDOUT' })));
  socket.once('connect', () => { socket.destroy(); resolve({ connected: true, errorCode: null }); });
  socket.once('error', error => resolve({ connected: false, errorCode: error.code }));
});
if (mode === 'allowed') assert.equal(result.connected, true, `External TCP canary unavailable: ${result.errorCode}`);
else {
  assert.equal(result.connected, false, 'Restore Node executable still has external TCP access.');
  assert.ok(['EACCES', 'ETIMEDOUT'].includes(result.errorCode), `Unexpected network failure: ${result.errorCode}`);
}
console.log(JSON.stringify({ address, ...result }));
