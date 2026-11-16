import assert from 'node:assert/strict';
import test from 'node:test';
import { capToolResult, isToolResultTruncated, TOOL_RESULT_MAX_CHARS } from '../lib/acp/toolOutput';
import { buildTurnParts } from '../app/features/chat/runtime/turnParts';

test('capToolResult keeps short output and flags long output', () => {
  assert.deepEqual(capToolResult('ok'), { text: 'ok', truncated: false });
  assert.deepEqual(capToolResult({ a: 1 }), { text: '{"a":1}', truncated: false });
  assert.deepEqual(capToolResult(undefined), { text: '""', truncated: false });
  const long = capToolResult('x'.repeat(TOOL_RESULT_MAX_CHARS + 1));
  assert.equal(long.text.length, TOOL_RESULT_MAX_CHARS);
  assert.equal(long.truncated, true);
  assert.equal(capToolResult('x'.repeat(TOOL_RESULT_MAX_CHARS)).truncated, false);
});

test('isToolResultTruncated prefers the stored flag and falls back to length for older chats', () => {
  const full = 'x'.repeat(TOOL_RESULT_MAX_CHARS);
  assert.equal(isToolResultTruncated({ result: 'short', resultTruncated: true }), true);
  assert.equal(isToolResultTruncated({ result: full, resultTruncated: false }), false);
  assert.equal(isToolResultTruncated({ result: full }), true);
  assert.equal(isToolResultTruncated({ result: 'short' }), false);
  assert.equal(isToolResultTruncated({}), false);
});

test('buildTurnParts carries the truncated flag onto the tool part', () => {
  const parts = buildTurnParts([
    { type: 'tool_start', toolName: 'grep', toolCallId: 't1', toolArgs: '{}' },
    { type: 'tool_complete', toolCallId: 't1', toolResult: 'cut', toolResultTruncated: true },
    { type: 'tool_complete', toolCallId: 't2', toolResult: 'cut2', toolResultTruncated: true },
  ]);
  assert.deepEqual(parts, [
    { kind: 'tool', toolName: 'grep', args: '{}', result: 'cut', resultTruncated: true, done: true },
    { kind: 'tool', toolName: 'tool', result: 'cut2', resultTruncated: true, done: true },
  ]);
  const prev = buildTurnParts([{ type: 'tool_complete', toolCallId: 't1', toolResult: 'cut' }]);
  const next = buildTurnParts([{ type: 'tool_complete', toolCallId: 't1', toolResult: 'cut', toolResultTruncated: true }], prev);
  assert.notEqual(next[0], prev[0]);
});
