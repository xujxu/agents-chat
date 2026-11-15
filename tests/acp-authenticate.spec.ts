import { expect, test } from '@playwright/test';
import { createSlowAgent, deleteAgent, login } from './followupQueueHelpers';

// Real server and ACP process: after authenticate, the server probes session/new and cancels the
// probe session. Agents never answer session/cancel, so sign-in must not wait for a reply.
test('sign-in returns promptly when the agent never answers session/cancel', async ({ page }) => {
  await login(page);
  const api = page.context().request;
  const agentId = await createSlowAgent(api, { SLOW_AGENT_SILENT_CANCEL: '1' });
  try {
    const started = Date.now();
    const response = await api.post('/api/acp', {
      data: { action: 'acp-authenticate', agentId, methodId: 'github' },
      timeout: 60_000,
    });
    expect(await response.json()).toEqual({ ok: true, result: {} });
    expect(Date.now() - started).toBeLessThan(15_000);
  } finally {
    await deleteAgent(api, agentId);
  }
});
