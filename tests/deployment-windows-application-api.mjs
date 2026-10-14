import assert from 'node:assert/strict';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

const [mode, chatId, readiness] = process.argv.slice(2);
assert.ok(readiness === undefined || readiness === 'wait-ready');
await verifyWindowsApplicationApi(mode, chatId, { waitReady: readiness === 'wait-ready' });
console.log(`PASS: managed Windows application API ${mode}`);
