import { expect, test } from '@playwright/test';
import {
  acknowledgeStreamSave, parseStreamSave, streamSaveBaseline, validateStreamSaves,
  type StreamSave, type StreamTurn,
} from './helpers/streamSaveBaseline';

const turn: StreamTurn = { userText: 'question', finalText: 'answer', agentId: 'alpha' };
const user = { id: 'u', type: 'user', content: 'question', ts: 1 };
const agent = { id: 'a', type: 'agent', agentId: 'alpha', content: '', ts: 2, pending: true };

function save(id: string, messages: Record<string, unknown>[]): StreamSave {
  return parseStreamSave({
    action: 'save-sync',
    operation: {
      operationId: id,
      expectedVersions: Object.fromEntries(messages.map(message => [String(message.id), null])),
      chat: { id: 'chat', messages },
    },
  });
}

function sequence(): StreamSave[] {
  const first = save('initial', [{
    ...user, sendStatus: 'pending', resendAgentIds: ['alpha'], resendMessage: 'question',
  }]);
  first.acknowledged = true;
  return [first, save('confirmation', [{ ...user }, { ...agent }])];
}

test('stream baseline waits for initial and confirmation acknowledgements', () => {
  expect(streamSaveBaseline([], turn)).toBeUndefined();
  const saves = sequence();
  expect(streamSaveBaseline(saves.slice(0, 1), turn)).toBeUndefined();
  expect(streamSaveBaseline(saves, turn)).toBeUndefined();
  saves[1].acknowledged = true;
  saves[0].acknowledged = false;
  expect(streamSaveBaseline(saves, turn)).toBeUndefined();
  saves[0].acknowledged = true;
  expect(streamSaveBaseline(saves, turn)).toBe(2);
});

test('stream baseline rejects invalid or extra saves rather than absorbing them', () => {
  const mutations: Array<(saves: StreamSave[]) => void> = [
    saves => { saves[1].operationId = saves[0].operationId; },
    saves => { saves[1].chatId = 'foreign'; },
    saves => { saves[1].messages[0].id = 'other-user'; },
    saves => { saves[1].messages[0].content = 'changed'; },
    saves => { saves[1].messages[0].sendStatus = 'pending'; },
    saves => { saves[1].messages[0].resendMessage = 'question'; },
    saves => { saves[0].messages[0].parts = [{ type: 'thinking', text: 'early' }]; },
    saves => { saves[1].messages[1].content = 'early thinking'; },
    saves => { saves[1].messages[1].parts = [{ type: 'thinking', text: 'early' }]; },
    saves => { saves[1].messages.push({ ...agent, id: 'extra' }); },
    saves => { saves[1].messages = [{ ...agent }]; },
    saves => { saves.push(save('extra', [{ ...agent, content: 'answer', pending: false }])); },
  ];
  for (const mutate of mutations) {
    const saves = sequence();
    saves[1].acknowledged = true;
    mutate(saves);
    expect(() => streamSaveBaseline(saves, turn)).toThrow();
  }
});

test('stream save parsing and acknowledgement failures are explicit', () => {
  expect(() => parseStreamSave({ action: 'save-sync' })).toThrow();
  expect(() => parseStreamSave({ action: 'unknown', chat: {} })).toThrow();
  expect(() => parseStreamSave({
    action: 'save-sync',
    operation: { operationId: 'delete', expectedVersions: {}, chat: {
      id: 'chat', messages: [], removedMessageIds: ['u'],
    } },
  })).toThrow();
  const initial = sequence()[0];
  initial.acknowledged = false;
  for (const [httpOk, body] of [
    [false, { ok: true, versions: { u: 1 } }],
    [true, { ok: false }],
    [true, null],
    [true, { ok: true, versions: {} }],
    [true, { ok: true, versions: { u: -1 } }],
  ] as const) {
    expect(() => acknowledgeStreamSave(initial, httpOk, body)).toThrow();
    expect(initial.acknowledged).toBe(false);
  }
  acknowledgeStreamSave(initial, true, { ok: true, versions: { u: 1 } });
  expect(initial.acknowledged).toBe(false);
});

test('stream final save preserves identity and occurs only after release', () => {
  const saves = sequence();
  saves[1].acknowledged = true;
  const final = save('final', [{ ...agent, content: 'answer', pending: false }]);
  saves.push(final);
  expect(() => validateStreamSaves(saves, turn)).toThrow();
  final.completionReleased = true;
  expect(() => validateStreamSaves(saves, turn)).not.toThrow();
  final.messages[0].id = 'different-agent';
  expect(() => validateStreamSaves(saves, turn)).toThrow();
  final.messages[0].id = 'a';
  saves.push(save('fourth', []));
  expect(() => validateStreamSaves(saves, turn)).toThrow();
});
