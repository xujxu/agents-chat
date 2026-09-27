import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { isRecord } from '../../lib/chatSyncProtocol';
import { createFixtureCompletion } from './fixtureCompletion';

export type StreamTurn = {
  userText: string;
  finalText: string;
  agentId: string;
};
export type StreamSave = {
  operationId: string;
  chatId: string;
  messages: Record<string, unknown>[];
  acknowledged: boolean;
  completionReleased: boolean;
};

export function parseStreamSave(body: unknown, completionReleased = false): StreamSave {
  assert.ok(isRecord(body) && body.action === 'save-sync', 'Expected inline save-sync');
  assert.ok(isRecord(body.operation), 'Missing inline save operation');
  const operation = body.operation;
  assert.ok(typeof operation.operationId === 'string' && operation.operationId.length > 0);
  assert.ok(isRecord(operation.expectedVersions), 'Missing expected versions');
  assert.ok(isRecord(operation.chat), 'Missing chat delta');
  const chat = operation.chat;
  assert.ok(typeof chat.id === 'string' && chat.id.length > 0);
  assert.ok(Array.isArray(chat.messages) && chat.messages.every(isRecord), 'Invalid messages');
  assert.ok(chat.removedMessageIds === undefined
    || (Array.isArray(chat.removedMessageIds) && chat.removedMessageIds.length === 0),
  'Unexpected message deletion');
  for (const message of chat.messages) {
    assert.ok(typeof message.id === 'string' && message.id.length > 0);
    assert.ok(typeof message.content === 'string');
    assert.ok(typeof message.ts === 'number' && Number.isFinite(message.ts));
    assert.ok(Object.hasOwn(operation.expectedVersions, message.id));
  }
  return {
    operationId: operation.operationId,
    chatId: chat.id,
    messages: chat.messages,
    acknowledged: false,
    completionReleased,
  };
}

export function acknowledgeStreamSave(save: StreamSave, httpOk: boolean, body: unknown): void {
  assert.ok(httpOk, 'Chat save HTTP failure');
  assert.ok(isRecord(body) && body.ok === true, 'Chat save API failure');
  assert.ok(isRecord(body.versions), 'Missing commit versions');
  for (const message of save.messages) {
    assert.ok(typeof message.id === 'string');
    const version = body.versions[message.id];
    assert.ok(typeof version === 'number' && Number.isSafeInteger(version) && version >= 0,
      'Invalid commit version');
  }
}

export function validateStreamSaves(saves: readonly StreamSave[], turn: StreamTurn): void {
  assert.ok(saves.length <= 3, 'Unexpected extra save');
  const initial = saves[0];
  if (!initial) return;
  assert.equal(new Set(saves.map(save => save.operationId)).size, saves.length,
    'Duplicate save operation');
  for (const save of saves) {
    assert.equal(save.chatId, initial.chatId, 'Foreign chat save');
    assert.equal(new Set(save.messages.map(message => message.id)).size, save.messages.length,
      'Duplicate message ID');
    for (const message of save.messages) {
      assert.ok(!Object.hasOwn(message, 'parts'), 'Frontend persisted message parts');
      assert.ok(message.attachments === undefined
        || (Array.isArray(message.attachments) && message.attachments.length === 0),
      'Unexpected attachments');
    }
  }
  assert.equal(initial.messages.length, 1, 'Initial save must contain only the user');
  const user = initial.messages[0];
  assert.equal(user.type, 'user');
  assert.equal(user.content, turn.userText);
  assert.equal(user.sendStatus, 'pending');
  assert.equal(user.sendError, undefined);
  assert.deepEqual(user.resendAgentIds, [turn.agentId]);
  assert.equal(user.resendMessage, turn.userText);

  const confirmation = saves[1];
  if (!confirmation) return;
  const users = confirmation.messages.filter(message => message.type === 'user');
  const agents = confirmation.messages.filter(message => message.type === 'agent');
  assert.equal(users.length, 1, 'Confirmation must update the same user');
  assert.ok(agents.length <= 1, 'Unexpected agent placeholder');
  assert.equal(confirmation.messages.length, users.length + agents.length);
  assert.equal(users[0].id, user.id, 'Changed user ID');
  assert.equal(users[0].content, user.content);
  assert.equal(users[0].ts, user.ts);
  for (const field of ['sendStatus', 'sendError', 'resendAgentIds', 'resendMessage']) {
    assert.equal(users[0][field], undefined, `Confirmation retained ${field}`);
  }
  if (agents[0]) {
    assert.equal(agents[0].agentId, turn.agentId);
    assert.equal(agents[0].content, '', 'Stream content saved before completion');
    assert.equal(agents[0].pending, true);
  }
  const final = saves[2];
  if (!final) return;
  assert.ok(final.completionReleased, 'Save arrived before completion release');
  assert.equal(final.messages.length, 1, 'Final delta must update only the agent');
  const answer = final.messages[0];
  assert.equal(answer.type, 'agent');
  assert.equal(answer.agentId, turn.agentId);
  assert.equal(answer.content, turn.finalText);
  assert.equal(answer.pending, false);
  if (agents[0]) assert.equal(answer.id, agents[0].id, 'Changed agent message ID');
}

export function streamSaveBaseline(
  saves: readonly StreamSave[], turn: StreamTurn,
): number | undefined {
  validateStreamSaves(saves, turn);
  assert.ok(saves.length <= 2, 'Save arrived before baseline was frozen');
  if (saves.length !== 2 || !saves.every(save => save.acknowledged)) return undefined;
  return saves.length;
}

export async function installStreamSaveFixture(page: Page, turn: StreamTurn) {
  const completion = createFixtureCompletion();
  const setupSaves: StreamSave[] = [];
  const saves: StreamSave[] = [];
  let started = false;
  let completionReleased = false;
  let confirmationHeld = false;
  let releaseConfirmation!: () => void;
  const confirmationGate = new Promise<void>(resolve => { releaseConfirmation = resolve; });
  await page.route('**/api/chats', route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body: unknown = route.request().postDataJSON();
    if (isRecord(body) && body.action === 'set-last-chat') {
      assert.ok(!body.chat && !body.operation, 'Save disguised as metadata action');
      return route.continue();
    }
    return completion.run(async () => {
      assert.ok(isRecord(body), 'Invalid chat request');
      const save = parseStreamSave(body, completionReleased);
      (started ? saves : setupSaves).push(save);
      if (started) validateStreamSaves(saves, turn);
      else assert.equal(save.messages.length, 0, 'Unexpected setup message save');
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
      const responseBody: unknown = await response.json();
      acknowledgeStreamSave(save, response.ok(), responseBody);
      if (started && saves[1] === save) {
        confirmationHeld = true;
        await confirmationGate;
      }
      await route.fulfill({ response });
      save.acknowledged = true;
    });
  });
  return {
    setupSaves,
    saves,
    get confirmationHeld() { return confirmationHeld; },
    releaseConfirmation,
    async beginTurn() {
      await completion.waitForCount(completion.count);
      assert.ok(setupSaves.every(save => save.acknowledged));
      started = true;
    },
    baseline() {
      completion.assertHealthy();
      return streamSaveBaseline(saves, turn);
    },
    assertStreaming(baseline: number) {
      completion.assertHealthy();
      validateStreamSaves(saves, turn);
      assert.equal(saves.length, baseline, 'Frontend saved during streaming');
    },
    releaseTurn(baseline: number) {
      this.assertStreaming(baseline);
      completionReleased = true;
    },
    finalReady(baseline: number) {
      completion.assertHealthy();
      validateStreamSaves(saves, turn);
      assert.ok(saves.length <= baseline + 1, 'Extra final save');
      return saves.length === baseline + 1 && saves.every(save => save.acknowledged);
    },
    async dispose() {
      releaseConfirmation();
      try {
        await completion.waitForCount(completion.count);
      } finally {
        await completion.close(() => page.goto('about:blank'), async () => {});
      }
    },
  };
}
