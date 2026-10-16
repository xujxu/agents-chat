import { inspectWindowsWorkerScope, inspectWindowsInactiveWorkerScope } from './windows-worker-scope.mjs';
import { assertWindowsTaskSourceStage } from './windows-task-transaction.mjs';
import { assertWindowsInactiveTaskSourceStage } from './windows-inactive-task-transaction.mjs';
import { prepareOwnedSourceBuild } from './owned-source-build.mjs';

export async function prepareWindowsSourceBuild(options) {
  return prepareSourceBuild(options, false);
}

export async function prepareWindowsInactiveSourceBuild(options) {
  return prepareSourceBuild(options, true);
}

async function prepareSourceBuild({
  scope, control, lock: suppliedLock, operation, node, npmCli, git, environment, pwsh, signal,
}, inactive) {
  const inspect = inactive ? inspectWindowsInactiveWorkerScope : inspectWindowsWorkerScope;
  const assertStage = inactive ? assertWindowsInactiveTaskSourceStage : assertWindowsTaskSourceStage;
  const { root, lock, observation, runtime, check } = await inspect({
    scope, control, lock: suppliedLock, node, pwsh, tools: [npmCli, git], signal,
  });
  const project = observation.project;
  return prepareOwnedSourceBuild({
    project, node, npmCli, operation, git, environment, signal,
    runtime, checkRead: check,
    checkMutation: ({ stopped, stage, commit, signal: stageSignal }) =>
      assertStage({ context: stopped, control: root, lock,
        generation: (inactive ? observation.retiredRuntime : observation.runtime).generation,
        stage, commit, signal: stageSignal }),
  });
}
