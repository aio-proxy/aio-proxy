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
});

test('invalid transforms JSON blocks the advanced section', () => {
  expect(sectionStatuses({ ...base, transformsValid: false }).advanced).toBe('todo');
});
