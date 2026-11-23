import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentFilePathParts } from '../app/features/files/fileWorkspaceHelpers';

test('file path parts join the agent folder with its own separator', () => {
  assert.deepEqual(getAgentFilePathParts('C:\\repo\\', 'docs/guide/plan.md'),
    { root: 'C:\\repo\\', folders: ['docs', 'guide'], name: 'plan.md', fullPath: 'C:\\repo\\docs\\guide\\plan.md' });
  assert.equal(getAgentFilePathParts('/home/me/repo', 'docs/plan.md').fullPath, '/home/me/repo/docs/plan.md');
  assert.equal(getAgentFilePathParts('/', 'plan.md').fullPath, '/plan.md');
  // A relay agent without a known folder shows only the relative path.
  assert.deepEqual(getAgentFilePathParts('', 'docs/plan.md'),
    { root: '', folders: ['docs'], name: 'plan.md', fullPath: 'docs/plan.md' });
});
