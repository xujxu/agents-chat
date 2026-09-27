import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { cancelVoiceJob, reserveVoiceJob } from '../lib/voice/jobs';

test('admission is global, remains occupied until release, and can be reused', () => {
  const id = randomUUID();
  const first = reserveVoiceJob('one', id, new AbortController().signal);
  try {
    assert.throws(() => reserveVoiceJob('two', randomUUID(), new AbortController().signal), /voice_busy/);
    cancelVoiceJob('one', id);
    assert.equal(first.signal.aborted, true);
    assert.throws(() => reserveVoiceJob('two', randomUUID(), new AbortController().signal), /voice_busy/);
  } finally { first.release(); }
  const next = reserveVoiceJob('two', randomUUID(), new AbortController().signal);
  next.release();
});

test('cancellation is account scoped, including when it overtakes upload', () => {
  const id = randomUUID();
  cancelVoiceJob('one', id);
  assert.throws(() => reserveVoiceJob('one', id, new AbortController().signal), /voice_cancelled/);
  const other = reserveVoiceJob('two', id, new AbortController().signal);
  try {
    cancelVoiceJob('one', id);
    assert.equal(other.signal.aborted, false);
  } finally { other.release(); }
});

test('request disconnection aborts inference; disconnected requests never acquire a slot', () => {
  const request = new AbortController();
  const job = reserveVoiceJob('one', randomUUID(), request.signal);
  try {
    request.abort();
    assert.equal(job.signal.aborted, true);
    assert.match(String(job.signal.reason), /voice_cancelled/);
  } finally { job.release(); }
  assert.throws(() => reserveVoiceJob('one', randomUUID(), request.signal), /voice_cancelled/);
});

test('hard deadline aborts at exactly 120 seconds and expires early-cancellation markers', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const early = randomUUID();
  cancelVoiceJob('one', early);
  const job = reserveVoiceJob('one', randomUUID(), new AbortController().signal);
  try {
    context.mock.timers.tick(119_999);
    assert.equal(job.signal.aborted, false);
    context.mock.timers.tick(1);
    assert.equal(job.signal.aborted, true);
    assert.match(String(job.signal.reason), /voice_timeout/);
  } finally { job.release(); }
  const next = reserveVoiceJob('one', early, new AbortController().signal);
  next.release();
});
