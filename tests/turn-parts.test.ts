import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPolledTurnEvents, buildTurnParts, isNoopMessagePatch, type TurnEventLog } from '../app/features/chat/runtime/turnParts';
import type { ChatMessage } from '../app/features/chat/chatTypes';

const events = [
  { type: 'thinking', text: 'plan' },
  { type: 'tool_start', toolName: 'grep', toolCallId: 't1', toolArgs: '{}' },
  { type: 'tool_complete', toolCallId: 't1', toolResult: 'ok' },
  { type: 'text_chunk', text: 'Hel' },
  { type: 'text_chunk', text: 'lo' },
];

test('buildTurnParts merges chunks and completes tools', () => {
  assert.deepEqual(buildTurnParts(events), [
    { kind: 'thinking', text: 'plan' },
    { kind: 'tool', toolName: 'grep', args: '{}', done: true, result: 'ok' },
    { kind: 'text', text: 'Hello' },
  ]);
});

test('buildTurnParts returns the previous array when a poll brings nothing new', () => {
  const first = buildTurnParts(events);
  assert.equal(buildTurnParts(events, first), first);
});

test('buildTurnParts reuses unchanged parts and replaces only the growing one', () => {
  const first = buildTurnParts(events);
  const next = buildTurnParts([...events, { type: 'text_chunk', text: '!' }], first);
  assert.notEqual(next, first);
  assert.equal(next[0], first[0]);
  assert.equal(next[1], first[1]);
  assert.notEqual(next[2], first[2]);
  assert.deepEqual(next[2], { kind: 'text', text: 'Hello!' });
});

test('buildTurnParts treats a completed tool as changed', () => {
  const running = buildTurnParts(events.slice(0, 2));
  const done = buildTurnParts(events.slice(0, 3), running);
  assert.notEqual(done[1], running[1]);
  assert.equal(done[0], running[0]);
});

test('applyPolledTurnEvents appends cursor polls and replaces on full polls', () => {
  const log: TurnEventLog = { events: [] };
  assert.equal(applyPolledTurnEvents(log, { id: 't1', events: events.slice(0, 2), eventsFrom: 0, totalEvents: 2 }), true);
  assert.equal(applyPolledTurnEvents(log, { id: 't1', events: events.slice(2), eventsFrom: 2, totalEvents: 5 }), true);
  assert.deepEqual(log, { turnId: 't1', events });
  assert.deepEqual(buildTurnParts(log.events), buildTurnParts(events));
  // A full poll (older servers, a new turn, or mocks without eventsFrom) replaces what was held.
  assert.equal(applyPolledTurnEvents(log, { id: 't2', events: events.slice(0, 1) }), true);
  assert.deepEqual(log, { turnId: 't2', events: events.slice(0, 1) });
});

test('applyPolledTurnEvents rejects polls it cannot line up', () => {
  const held = () => ({ turnId: 't1', events: events.slice(0, 2) });
  assert.equal(applyPolledTurnEvents(held(), { id: 't1', events: events.slice(3), eventsFrom: 3, totalEvents: 5 }), false);
  assert.equal(applyPolledTurnEvents(held(), { id: 't2', events: events.slice(2), eventsFrom: 2, totalEvents: 5 }), false);
  assert.equal(applyPolledTurnEvents(held(), { id: 't1', events: events.slice(2, 3), eventsFrom: 2, totalEvents: 5 }), false);
});

test('isNoopMessagePatch detects identical streaming patches', () => {
  const parts = buildTurnParts(events);
  const message: ChatMessage = {
    id: 'm', ts: 1, type: 'agent', content: 'Hello', pending: true, statusText: 'Thinking', parts,
    userRequest: { requestId: 'r', question: 'ok?' } as ChatMessage['userRequest'],
  };
  assert.equal(isNoopMessagePatch(message, {
    pending: true, statusText: 'Thinking', parts, content: 'Hello',
    userRequest: { requestId: 'r', question: 'ok?' } as ChatMessage['userRequest'],
  }), true);
  assert.equal(isNoopMessagePatch(message, { statusText: 'Executing tool' }), false);
  assert.equal(isNoopMessagePatch(message, { parts: [...parts] }), false);
  assert.equal(isNoopMessagePatch(message, { userRequest: undefined }), false);
  assert.equal(isNoopMessagePatch({ ...message, userRequest: undefined }, { userRequest: undefined }), true);
});
