import { expect, test } from '@rstest/core';

import { blockingSections, sectionStatuses } from './section-status';

const base = {
  kind: 'api' as const,
  mode: 'create' as const,
  id: 'p1',
  baseURL: 'https://x.example/v1',
  protocol: 'openai-compatible',
  models: ['m1'],
  aliasIssues: [],
  transformsValid: true,
  weightTie: false,
};

test('an empty baseURL on an api provider is todo and blocks; an empty apiKey is not', () => {
  const statuses = sectionStatuses({ ...base, baseURL: '' });
  expect(statuses.connection).toBe('todo');
  expect(blockingSections(statuses)).toEqual(['connection']);
  expect(sectionStatuses(base).connection).toBe('ok');
  // `baseURL: ''` short-circuits the `||` before `protocol` is read, so the protocol half needs
  // its own case — and a missing `protocol` is the default state of every api create draft.
  expect(sectionStatuses({ ...base, protocol: '' }).connection).toBe('todo');
  // ai-sdk drafts carry neither field; widening the guard to `!== 'oauth'` would make their
  // connection permanently todo, i.e. an unsaveable-looking draft.
  expect(sectionStatuses({ ...base, kind: 'ai-sdk', baseURL: undefined, protocol: undefined }).connection).toBe('ok');
});

test('blocking sections come back in rail order, whatever order the statuses were built in', () => {
  // Keys deliberately out of SECTION_ORDER: a naive `Object.keys(statuses).filter(...)` would
  // return ['advanced', 'identity'] and mis-order the save-blocking footer.
  expect(
    blockingSections({ advanced: 'todo', identity: 'todo', connection: 'ok', models: 'ok', routing: 'ok' }),
  ).toEqual(['identity', 'advanced']);
});

test('an empty provider id blocks in create mode only', () => {
  expect(sectionStatuses({ ...base, id: '' }).identity).toBe('todo');
  expect(sectionStatuses({ ...base, id: '', mode: 'edit' }).identity).toBe('ok');
});

test('alias issues raise routing to todo because the schema would reject the save', () => {
  const statuses = sectionStatuses({ ...base, aliasIssues: [{ code: 'target-missing', alias: 'smart' }] });
  expect(statuses.routing).toBe('todo');
});

test('a stale whitelist entry is attention and does not block', () => {
  const statuses = sectionStatuses({
    ...base,
    kind: 'oauth',
    capabilityKey: 'p\0c',
    models: ['gone'],
    discoveredModels: ['here'],
  });
  expect(statuses.models).toBe('attention');
  expect(blockingSections(statuses)).toEqual([]);
  // Staleness is only computed when a catalog was fetched. Dropping that guard makes
  // `new Set(undefined)` empty, so every whitelisted model reads as stale on every provider.
  expect(sectionStatuses(base).models).toBe('ok');
});

test('a weight tie is attention on routing', () => {
  expect(sectionStatuses({ ...base, weightTie: true }).routing).toBe('attention');
});

test('an oauth provider needs a capability, but never its own id — the server assigns that', () => {
  const statuses = sectionStatuses({
    ...base,
    kind: 'oauth',
    id: '',
    capabilityKey: '',
    models: [],
  });
  expect(statuses.connection).toBe('todo');
  // Same empty id is a todo for api/ai-sdk (test above); dropping the `kind !== 'oauth'`
  // guard in `identity` must red HERE, since nothing else exercises that clause.
  expect(statuses.identity).toBe('ok');
  // Alias-only providers ship an empty `models`; making that a todo would put an uncleanable
  // entry in the save-blocking footer.
  expect(statuses.models).toBe('ok');
});

test('invalid transforms JSON blocks the advanced section', () => {
  expect(sectionStatuses({ ...base, transformsValid: false }).advanced).toBe('todo');
});
