import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildUserRequestAnswer,
  chatNameFromPrompt,
  cleanIncomingText,
  conversationSettingKey,
  isAllowedServiceUrl,
  isBotMentioned,
  newTeamsChatId,
  normalizeServiceUrl,
  parseCommand,
  parseEmailList,
  splitForTeams,
} from '../lib/channels/teams/util.ts';

// Commands
assert.deepEqual(parseCommand('/new hello world'), { name: 'new', args: 'hello world' });
assert.deepEqual(parseCommand('/STOP'), { name: 'stop', args: '' });
assert.deepEqual(parseCommand('/model  opus '), { name: 'model', args: 'opus' });
assert.equal(parseCommand('/unknown'), null);
assert.equal(parseCommand('hello /new'), null);

// Incoming text cleanup
assert.equal(cleanIncomingText('<at>agent-xujx</at> hi &amp; <b>bye</b>'), 'hi & bye');
assert.equal(cleanIncomingText(undefined), '');

// Group chats: only explicit @mentions of the bot count, and other people's names are kept
const botId = '28:bot-app';
const mentions = [
  { type: 'mention', text: '<at>agent-xujx</at>', mentioned: { id: botId, name: 'agent-xujx' } },
  { type: 'mention', text: '<at>Alice</at>', mentioned: { id: '29:alice', name: 'Alice' } },
];
assert.ok(isBotMentioned(mentions, botId));
assert.ok(!isBotMentioned([mentions[1]], botId));
assert.ok(!isBotMentioned(undefined, botId));
assert.ok(!isBotMentioned([{ type: 'clientInfo' }], botId));
assert.equal(cleanIncomingText('<at>agent-xujx</at> ask <at>Alice</at> about /new', mentions, botId), 'ask Alice about /new');
assert.equal(cleanIncomingText('<at>agent-xujx</at> /stop', mentions, botId), '/stop');
assert.equal(cleanIncomingText('<at>Alice</at> hi', [mentions[1]], botId), 'Alice hi');

// Ids and settings keys are stable per conversation and never leak the raw id
const key = conversationSettingKey('a:1-conv');
assert.equal(key, conversationSettingKey('a:1-conv'));
assert.match(key, /^teams\.chat\.[0-9a-f]{16}$/);
assert.match(newTeamsChatId('a:1-conv', 1700000000000), /^teams-[0-9a-f]{12}-[0-9a-z]+$/);
assert.ok(chatNameFromPrompt('x'.repeat(200)).length <= 'Teams: '.length + 60);
assert.ok(chatNameFromPrompt('fix build').startsWith('Teams: '));

// Only real Bot Framework service URLs are trusted
assert.ok(isAllowedServiceUrl('https://smba.trafficmanager.net/amer/'));
assert.ok(isAllowedServiceUrl('https://smba.trafficmanager.net/teams/'));
assert.ok(!isAllowedServiceUrl('http://smba.trafficmanager.net/amer/'));
assert.ok(!isAllowedServiceUrl('https://evil.example.com/'));
assert.ok(!isAllowedServiceUrl('https://smba.trafficmanager.net.evil.com/'));
assert.equal(normalizeServiceUrl('https://smba.trafficmanager.net/amer'), 'https://smba.trafficmanager.net/amer/');

// Long replies are split under the Teams limit without losing content
const long = Array.from({ length: 50 }, (_, i) => `paragraph ${i} ${'y'.repeat(300)}`).join('\n\n');
const parts = splitForTeams(long, 2000);
assert.ok(parts.length > 1);
assert.ok(parts.every((p) => p.length <= 2000));
assert.equal(parts.join('').replace(/\s+/g, ''), long.replace(/\s+/g, ''));
assert.deepEqual(splitForTeams('short', 2000), ['short']);
assert.ok(splitForTeams('z'.repeat(4500), 2000).every((p) => p.length <= 2000));

assert.deepEqual(parseEmailList(' A@x.com, b@Y.com ;; '), ['a@x.com', 'b@y.com']);
assert.deepEqual(parseEmailList(undefined), []);

// Permission-style requests: answer by number or by label
const permission = { id: 'r1', options: [{ optionId: 'allow', label: 'Allow once' }, { optionId: 'deny', label: 'Deny' }] };
assert.deepEqual(buildUserRequestAnswer(permission, '2'), { optionId: 'deny' });
assert.deepEqual(buildUserRequestAnswer(permission, 'allow once'), { optionId: 'allow' });
assert.equal(buildUserRequestAnswer(permission, 'maybe'), null);

// Question-style requests: one answer per line
const questions = { id: 'r2', questions: [{ id: 'q1', header: 'Name' }, { id: 'q2', header: 'Color' }] };
assert.deepEqual(buildUserRequestAnswer(questions, 'Bob\nBlue'), { answers: { Name: 'Bob', Color: 'Blue' } });

// Middleware must let Bot Framework reach the endpoint (it authenticates with its own JWT)
const middleware = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');
const matcherSource = middleware.match(/'(\/\(\(\?!.*?\)\.\*\))'/)?.[1];
assert.ok(matcherSource, 'middleware matcher should be present');
const matcher = new RegExp(`^${matcherSource.replace(/\\\\/g, '\\')}$`);
assert.ok(!matcher.test('/api/teams/messages'), 'Teams endpoint must bypass session middleware');
assert.ok(matcher.test('/api/acp'), 'other APIs must stay protected');
assert.ok(matcher.test('/api/teamsx'), 'exclusion must not cover unrelated prefixes');

console.log('teams bot util checks passed');
