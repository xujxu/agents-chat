import { runLinuxDeploymentCommand } from './linux-deployment-command.mjs';

export function runLinuxUpdateCommand(options) {
  return runLinuxDeploymentCommand({ ...options, operation: 'update' });
}
