import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, '..');
const outputDir = join(projectDir, 'dist', 'release');
const target = process.env.RELEASE_TARGET || `${process.platform}-${process.arch}`;
const bundleDir = join(outputDir, `agents-chat-${target}`);

function resetDir(dir) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
}

function copyIfExists(source, destination) {
  if (!existsSync(source)) return;
  cpSync(source, destination, { recursive: true });
}

resetDir(bundleDir);
mkdirSync(join(bundleDir, '.next'), { recursive: true });

copyIfExists(join(projectDir, '.next', 'standalone'), bundleDir);
copyIfExists(join(projectDir, '.next', 'static'), join(bundleDir, '.next', 'static'));
copyIfExists(join(projectDir, 'public'), join(bundleDir, 'public'));
copyIfExists(join(projectDir, '.env.example'), join(bundleDir, '.env.example'));
copyIfExists(join(projectDir, 'README.md'), join(bundleDir, 'README.md'));

for (const path of ['.git', 'dist']) {
  rmSync(join(bundleDir, path), { force: true, recursive: true });
}

const launcherDir = join(bundleDir, 'scripts');
mkdirSync(launcherDir, { recursive: true });
cpSync(join(projectDir, 'scripts', 'configure-voice.mjs'), join(launcherDir, 'configure-voice.mjs'));
cpSync(join(projectDir, 'scripts', 'voice'), join(launcherDir, 'voice'), { recursive: true });

// CLI-only dependencies are not discovered by Next's standalone tracer.
function copyCliDependency(name, requireFrom) {
  const manifest = requireFrom.resolve(`${name}/package.json`);
  const destination = join(bundleDir, 'node_modules', name);
  if (existsSync(destination)) return;
  cpSync(dirname(manifest), destination, { recursive: true });
  for (const dependency of Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {})) {
    copyCliDependency(dependency, createRequire(manifest));
  }
}
if (existsSync(join(projectDir, 'node_modules/yauzl/package.json'))) {
  copyCliDependency('yauzl', createRequire(join(projectDir, 'package.json')));
}

writeFileSync(
  join(launcherDir, 'start-release.sh'),
  [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'project_dir="$(cd "$script_dir/.." && pwd)"',
    'port="${PORT:-3010}"',
    '',
    'cd "$project_dir"',
    'exec node server.js --port "$port"',
    '',
  ].join('\n'),
  'utf8',
);
chmodSync(join(launcherDir, 'start-release.sh'), 0o755);

writeFileSync(
  join(launcherDir, 'start-release.ps1'),
  [
    'param(',
    '    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3010 })',
    ')',
    '',
    "$ErrorActionPreference = 'Stop'",
    '$ProjectDir = Split-Path -Parent $PSScriptRoot',
    'Set-Location $ProjectDir',
    'node .\\server.js --port $Port',
    '',
  ].join('\n'),
  'utf8',
);

writeFileSync(
  join(bundleDir, 'RELEASE.txt'),
  `Agents Chat release bundle

Contents:
- Next.js standalone server bundle
- static assets from .next/static
- public assets
- startup scripts in scripts/

Quick start:
- Linux/macOS: PORT=3010 ./scripts/start-release.sh
- Windows: powershell -ExecutionPolicy Bypass -File .\\scripts\\start-release.ps1

Before starting, create .env.local from .env.example and fill in the required values.

Optional voice setup (also run when upgrading an existing release):
  node scripts/configure-voice.mjs
The interactive menu defaults to keeping the current configuration.
For automation use --non-interactive (preserve) or --model disabled.
Enabling a native model currently requires a verified Linux x86_64 or Windows x64 Actions
package: --package-dir DIR --manifest-sha256 SHA256. Alternatively opt in to
--model sensevoice-small-q8 --experimental-download with authenticated gh.
This fetches pinned, expiring Actions candidates, not public release-approved
packages. Public runtime publication and full acceptance remain separate.
If upgrading, keep performs no download; no implicit acquisition occurs.
Keep .env.local and .data/voice when replacing application files during upgrades.
Disabled voice hides the microphone button after restart/page reload.
Windows: use --service-user ACCOUNT-OR-SID when the server runs as a different
account. Its registry hive must be loaded to check environment overrides.
Source Windows installs/upgrades use scripts/setup.ps1 or scripts/deploy.ps1;
interactive voice selection defaults to keep on every upgrade. Startup never prompts.
Native macOS voice packages are not yet supported. Windows Server CI does not
constitute actual Windows 11 or full-corpus release acceptance.
`,
  'utf8',
);

console.log(`Prepared release bundle: ${bundleDir}`);
