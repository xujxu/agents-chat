import { runLinuxCommandEntry } from './linux-command-entry.mjs';

await runLinuxCommandEntry({ operation: 'deploy', entryUrl: import.meta.url });
