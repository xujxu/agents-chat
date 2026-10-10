import { parseArguments } from './cli.mjs';

const policyValues = new Map([
  ['--task-logon-type', ['logonType', ['Interactive', 'S4U']]],
  ['--task-trigger-type', ['triggerType', ['AtLogOn', 'AtStartup']]],
]);
const unsupported = () => Object.assign(new Error(
  'First-task policy requires deploy with explicit NoTunnel, dependency installation and verified startup.',
), { code: 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED' });

export function parseWindowsCommandArguments(operation, args) {
  if (!Array.isArray(args)) throw new Error('Invalid Windows command arguments.');
  const common = [];
  const policy = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument !== '--no-tunnel' && !policyValues.has(argument)) {
      common.push(argument);
      continue;
    }
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    if (argument === '--no-tunnel') {
      policy.noTunnel = true;
    } else {
      const [name, values] = policyValues.get(argument);
      const value = args[++index];
      if (!values.includes(value)) throw unsupported();
      policy[name] = value;
    }
  }
  const options = parseArguments(operation, common);
  if (!seen.size) return options;
  if (options.operation !== 'deploy' || !policy.noTunnel || options.noInstall
    || options.dryRun || options.waitSeconds === 0) throw unsupported();
  return {
    ...options, firstInstall: true,
    logonType: policy.logonType ?? 'Interactive', triggerType: policy.triggerType ?? 'AtLogOn',
  };
}
