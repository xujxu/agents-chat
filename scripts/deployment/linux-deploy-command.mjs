import { runLinuxDeploymentCommand } from './linux-deployment-command.mjs';

export function runLinuxDeployCommand(options) {
  return runLinuxDeploymentCommand({ ...options, operation: 'deploy' });
}
