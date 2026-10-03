import { inspectWindowsWorkerScope } from './windows-worker-scope.mjs';
import { assertWindowsTaskSourceStage } from './windows-task-transaction.mjs';
import { prepareOwnedSourceBuild } from './owned-source-build.mjs';

export async function prepareWindowsSourceBuild({
  scope, control, lock: suppliedLock, operation, node, npmCli, git, environment, pwsh, signal,
}) {
  const { root, lock, observation, runtime, check } = await inspectWindowsWorkerScope({
    scope, control, lock: suppliedLock, node, pwsh, tools: [npmCli, git], signal,
  });
  const project = observation.project;
  return prepareOwnedSourceBuild({
    project, node, npmCli, operation, git, environment, signal,
    runtime, checkRead: check,
    checkMutation: ({ stopped, stage, commit, signal: stageSignal }) =>
      assertWindowsTaskSourceStage({ context: stopped, control: root, lock,
        generation: observation.runtime.generation, stage, commit, signal: stageSignal }),
  });
}
