const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scripts = path.resolve(__dirname, '..', 'scripts');
const read = (file) => fs.readFileSync(path.join(scripts, file), 'utf8');

function includesAll(script, ...needles) {
  return needles.every((needle) => script.includes(needle));
}

for (const operation of ['deploy', 'update']) {
  const script = read(`${operation}.ps1`);
  assert(
    includesAll(script, 'deployment/windows-public-command.ps1', `Invoke-WindowsPublicCommand -Operation ${operation}`,
      '-Options $PSBoundParameters', '$ProjectDir', '$TaskName', '$WaitSeconds', '$Status', '$Json'),
    `${operation}.ps1 should delegate explicit public options to the shared command boundary`
  );
  assert(
    !/Stop-Process|Stop-Port3000Processes|Unregister-ScheduledTask|Start-ScheduledTask|npm install|npm run build/.test(script),
    `${operation}.ps1 must not bypass owned deployment with port-wide cleanup, task mutation or direct builds`
  );
  assert(
    !/WatchdogLog|LastWriteTimeUtc|LastRunTime/.test(script),
    `${operation}.ps1 must not use log timestamps or Scheduler timestamps as readiness authority`
  );
}

const command = read('deployment/windows-public-command.ps1');
assert(
  includesAll(command, 'windows-public-context.mjs', 'windows-command-supervisor.ps1',
    '-PrepareDirectories', '-ReturnOutcome', '$code = $supervised.Code', '$result = $supervised.Result'),
  'public mutations should use the private supervisor and preserve its original outcome and exit code'
);
assert(
  includesAll(command, "$context.operation -ceq 'status'", 'windows-command-entry.mjs',
    'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED'),
  'read-only status and unsupported modes should use the explicit command admission boundary'
);

const admission = read('deployment/windows-deployment-command.mjs');
assert(
  includesAll(admission, 'inspectWindowsManagedTask({ project, taskName, pwsh, signal })',
    'runWindowsLiveDeployment({', 'scope, control, lock, node, npmCli, git, pwsh'),
  'the transaction must receive the observed managed-task scope rather than unrelated process or log evidence'
);

console.log('public Windows command delegation checks passed; native suites verify task ownership and readiness');
