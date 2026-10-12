import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

const [mode, chatId] = process.argv.slice(2);
await verifyWindowsApplicationApi(mode, chatId);
console.log(`PASS: managed Windows application API ${mode}`);
