import { runLinuxCommandEntry } from './linux-command-entry.mjs';

await runLinuxCommandEntry({ operation: 'update', entryUrl: import.meta.url });
