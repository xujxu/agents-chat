// Test helper: write or check a marker row in a chat database.
// Usage: node tests/deploy/marker.mjs <write|has> <db path> <value>
import { DatabaseSync } from 'node:sqlite';

const [command, file, value] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 10000; CREATE TABLE IF NOT EXISTS deploy_marker (v TEXT)');
if (command === 'write') {
  db.prepare('INSERT INTO deploy_marker (v) VALUES (?)').run(value);
} else {
  process.exitCode = db.prepare('SELECT 1 FROM deploy_marker WHERE v = ?').get(value) ? 0 : 1;
}
db.close();
