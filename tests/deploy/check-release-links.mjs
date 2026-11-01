// Test helper: fail if a link inside a release points outside it (except into shared/).
// Usage: node tests/deploy/check-release-links.mjs <release dir> <shared dir>
import fs from 'node:fs';
import path from 'node:path';

const [release, shared] = process.argv.slice(2).map((p) => fs.realpathSync(p));
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const bad = [];

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(p); } catch { bad.push(`${p} -> (broken)`); continue; }
      if (!inside(target, release) && !inside(target, shared)) bad.push(`${p} -> ${target}`);
    } else if (entry.isDirectory()) {
      walk(p);
    }
  }
})(release);

if (bad.length) {
  console.error(`Links leaving the release ${release}:\n  ${bad.slice(0, 20).join('\n  ')}`);
  process.exitCode = 1;
}
