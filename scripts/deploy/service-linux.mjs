// systemd adapter.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './fsops.mjs';

export function createLinuxService({ name = 'agents-chat', root }) {
  const unitPath = `/etc/systemd/system/${name}.service`;
  const current = path.join(root, 'current');
  const execStart = `/bin/sh ${path.join(current, 'scripts', 'run-release.sh')}`;
  const systemctl = (...args) => run('systemctl', args, { capture: true, step: 'service' });

  function readUnit() {
    return fs.readFileSync(unitPath, 'utf8');
  }

  function writeUnit(text) {
    fs.writeFileSync(unitPath, text);
    systemctl('daemon-reload');
    systemctl('enable', name);
  }

  function setPortLines(text, port) {
    const lines = text.split('\n').filter((l) => !/^Environment=(PORT|HOSTNAME)=/.test(l));
    const at = lines.findIndex((l) => l.startsWith('WorkingDirectory='));
    lines.splice(at + 1, 0, `Environment=PORT=${port}`, 'Environment=HOSTNAME=0.0.0.0');
    return lines.join('\n');
  }

  return {
    name,
    exists: () => fs.existsSync(unitPath),

    settings() {
      const text = readUnit();
      const value = (key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? null;
      return { user: value('User'), workingDirectory: value('WorkingDirectory') };
    },

    pointsInto(dir) {
      const wd = this.settings().workingDirectory;
      return Boolean(wd) && path.resolve(wd) === path.resolve(dir);
    },

    install({ user, port }) {
      const group = run('id', ['-gn', user], { capture: true, step: 'service' }).stdout.trim();
      const template = fs.readFileSync(path.join(current, 'scripts', 'agents-chat.service'), 'utf8');
      writeUnit(
        template
          .replaceAll('__USER__', user)
          .replaceAll('__GROUP__', group)
          .replaceAll('__ROOT__', root)
          .replaceAll('__PORT__', String(port)),
      );
    },

    // Re-point an existing unit at the release layout, keeping everything else.
    adopt({ oldDir, port }) {
      let text = readUnit()
        .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${current}`)
        .replace(/^ExecStart=.*$/m, `ExecStart=${execStart}`)
        .replaceAll(path.join(oldDir, '.env.local'), path.join(root, 'shared', '.env.local'));
      writeUnit(setPortLines(text, port));
    },

    backup(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(unitPath, path.join(dir, `${name}.service`));
    },

    restore(dir) {
      fs.copyFileSync(path.join(dir, `${name}.service`), unitPath);
      systemctl('daemon-reload');
    },

    remove() {
      run('systemctl', ['disable', '--now', name], { capture: true, allowFail: true });
      fs.rmSync(unitPath, { force: true });
      systemctl('daemon-reload');
    },

    stop: () => systemctl('stop', name),
    start: () => systemctl('start', name),
    serviceUser() {
      return this.settings().user || 'root';
    },
  };
}
