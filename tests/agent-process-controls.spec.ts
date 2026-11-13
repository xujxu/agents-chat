import { expect, test } from '@playwright/test';
import { createSlowAgent, deleteAgent, login, startBusyChat } from './followupQueueHelpers';

// Real server + tests/fixtures/slow-acp-agent.mjs: Stop must end a live reply at once,
// keep the agent out of page-load warmup, and Start must bring the chat back.
test('stop ends a live reply and start resumes the chat', async ({ page }) => {
  await login(page);
  const api = page.request;
  const agentId = await createSlowAgent(api, { SLOW_AGENT_DELAY_MS: '60000' });
  const acp = async (data: Record<string, unknown>) => {
    const response = await api.post('/api/acp', { data: { agentId, ...data } });
    return response.json();
  };
  try {
    const textarea = await startBusyChat(page, agentId);
    expect(await acp({ action: 'get-agent-config' })).toMatchObject({ processState: 'running' });

    const stopped = await acp({ action: 'stop-agent' });
    expect(stopped).toMatchObject({ ok: true, wasRunning: true, processState: 'stopped' });
    await expect(page.getByRole('button', { name: 'Queue follow-up' })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.message.agent').last()).toContainText('Agent stopped', { timeout: 15_000 });

    const warm = await acp({ action: 'warm-local-agents' });
    expect(warm.agents.find((agent: { agentId: string }) => agent.agentId === agentId)).toMatchObject({ status: 'skipped_stopped' });
    expect(await acp({ action: 'get-agent-config' })).toMatchObject({ processState: 'stopped' });

    // Not running, so this saves without a restart.
    const updated = await acp({ action: 'update-agent-config', updates: { env: { SLOW_AGENT_DELAY_MS: '200' } } });
    expect(updated).toMatchObject({ ok: true, restarted: false });

    expect(await acp({ action: 'restart-agent' })).toMatchObject({ ok: true, wasRunning: false, settled: true, processState: 'running' });
    await textarea.fill(`@${agentId} after restart`);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.message.agent').last()).toContainText('Turn 1 done', { timeout: 30_000 });
  } finally {
    await deleteAgent(api, agentId);
  }
});
