import { expect, test } from '@rstest/core';

import { toSpanAttributeRows } from './span-attribute-rows';

const attributes = {
  'gen_ai.request.model': 'claude-sonnet-4-6',
  'aio_proxy.provider.id': 'anthropic-primary',
  'aio_proxy.provider.kind': 'api',
  'http.status_code': 429,
  'aio_proxy.request.stream': true,
  'aio_proxy.route.candidates': ['anthropic-primary', 'anthropic-backup'],
};

test('sorts rows by attribute key so the list never reshuffles between spans', () => {
  const keys = toSpanAttributeRows(attributes, '').map((row) => row.key);

  expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right)));
  expect(keys[0]).toBe('aio_proxy.provider.id');
});

test('formats values as readable text', () => {
  const byKey = new Map(toSpanAttributeRows(attributes, '').map((row) => [row.key, row.value]));

  expect(byKey.get('gen_ai.request.model')).toBe('claude-sonnet-4-6');
  expect(byKey.get('http.status_code')).toBe('429');
  expect(byKey.get('aio_proxy.request.stream')).toBe('true');
  expect(byKey.get('aio_proxy.route.candidates')).toBe('anthropic-primary, anthropic-backup');
});

test('matches the query against both keys and values', () => {
  expect(toSpanAttributeRows(attributes, ' STATUS ').map((row) => row.key)).toEqual(['http.status_code']);
  expect(toSpanAttributeRows(attributes, 'sonnet').map((row) => row.key)).toEqual(['gen_ai.request.model']);
  expect(toSpanAttributeRows(attributes, 'nothing-matches-this')).toEqual([]);
});

test('offers a numeric HTTP status filter, and no filter for attributes the list page cannot query', () => {
  const byKey = new Map(toSpanAttributeRows(attributes, '').map((row) => [row.key, row.filter]));

  expect(byKey.get('http.status_code')).toEqual({ finalHttpStatus: 429 });
  expect(byKey.get('aio_proxy.provider.id')).toEqual({ finalProviderId: 'anthropic-primary' });
  expect(byKey.get('aio_proxy.provider.kind')).toBeUndefined();
  expect(byKey.get('aio_proxy.route.candidates')).toBeUndefined();
});
