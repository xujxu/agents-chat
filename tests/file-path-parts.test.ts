import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentFilePathParts, getAgentHostLabel } from '../app/features/files/fileWorkspaceHelpers';

test('file path parts join the agent folder with its own separator', () => {
  assert.deepEqual(getAgentFilePathParts('C:\\repo\\', 'docs/guide/plan.md'),
    { root: 'C:\\repo\\', folders: ['docs', 'guide'], name: 'plan.md', fullPath: 'C:\\repo\\docs\\guide\\plan.md' });
  assert.equal(getAgentFilePathParts('/home/me/repo', 'docs/plan.md').fullPath, '/home/me/repo/docs/plan.md');
  assert.equal(getAgentFilePathParts('/', 'plan.md').fullPath, '/plan.md');
  // A relay agent without a known folder shows only the relative path.
  assert.deepEqual(getAgentFilePathParts('', 'docs/plan.md'),
    { root: '', folders: ['docs'], name: 'plan.md', fullPath: 'docs/plan.md' });
});

test('host label names the relay node or this server', () => {
  assert.deepEqual(getAgentHostLabel({ id: 'a', relay: true, hostName: 'DevBox' }), { icon: '🌐', name: 'DevBox', title: 'Remote node: DevBox' });
  // Older servers send no hostName: fall back to the relay connection.
  assert.equal(getAgentHostLabel({ id: 'a', relay: true, relayConnectionName: 'node-7' })?.name, 'node-7');
  assert.deepEqual(getAgentHostLabel({ id: 'a', hostName: 'WEB-01' }), { icon: '🖥', name: 'WEB-01', title: 'Server: WEB-01' });
  assert.equal(getAgentHostLabel({ id: 'a' }), null);
  assert.equal(getAgentHostLabel(undefined), null);
});