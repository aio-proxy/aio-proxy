import { expect, test } from '@rstest/core';

import { toSpanAttributeRows } from './span-attribute-rows';

// Shaped like a failed failover attempt: on an attempt span the provider, response model and status
// describe this one hop, while the same keys on the root span describe how the trace ended.
const attributes = {
  'gen_ai.request.model': 'claude-sonnet-4-6',
  'gen_ai.response.model': 'claude-sonnet-4-5',
  'aio_proxy.provider.id': 'anthropic-primary',
  'aio_proxy.provider.kind': 'api',
  'http.response.status_code': 429,
  'aio_proxy.request.stream': true,
  'aio_proxy.route.candidates': ['anthropic-primary', 'anthropic-backup'],
};

const filtersOf = (isRoot: boolean) =>
  new Map(toSpanAttributeRows(attributes, '', isRoot).map((row) => [row.key, row.filter]));

test('sorts rows by attribute key so the list never reshuffles between spans', () => {
  const keys = toSpanAttributeRows(attributes, '', true).map((row) => row.key);

  expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right)));
  expect(keys[0]).toBe('aio_proxy.provider.id');
});

test('formats values as readable text', () => {
  const byKey = new Map(toSpanAttributeRows(attributes, '', true).map((row) => [row.key, row.value]));

  expect(byKey.get('gen_ai.request.model')).toBe('claude-sonnet-4-6');
  expect(byKey.get('http.response.status_code')).toBe('429');
  expect(byKey.get('aio_proxy.request.stream')).toBe('true');
  expect(byKey.get('aio_proxy.route.candidates')).toBe('anthropic-primary, anthropic-backup');
});

test('matches the query against both keys and values', () => {
  expect(toSpanAttributeRows(attributes, ' STATUS ', true).map((row) => row.key)).toEqual([
    'http.response.status_code',
  ]);
  expect(toSpanAttributeRows(attributes, 'sonnet-4-5', true).map((row) => row.key)).toEqual(['gen_ai.response.model']);
  expect(toSpanAttributeRows(attributes, 'nothing-matches-this', true)).toEqual([]);
});

test('filters the trace by its final status and model from the root span', () => {
  const byKey = filtersOf(true);

  expect(byKey.get('http.response.status_code')).toEqual({ finalHttpStatus: 429 });
  expect(byKey.get('gen_ai.response.model')).toEqual({ finalModelId: 'claude-sonnet-4-5' });
  // Attempt-only key: it names the hop's provider, never the trace's final one.
  expect(byKey.get('aio_proxy.provider.id')).toBeUndefined();
  expect(byKey.get('aio_proxy.provider.kind')).toBeUndefined();
  expect(byKey.get('aio_proxy.route.candidates')).toBeUndefined();
});

test('withholds the final-status and final-model filters on a non-root span', () => {
  const byKey = filtersOf(false);

  // A 429 attempt inside a 200 trace: filtering on it would exclude the trace the user came from.
  expect(byKey.get('http.response.status_code')).toBeUndefined();
  expect(byKey.get('gen_ai.response.model')).toBeUndefined();
  // The inbound requested model is the same on every span, so its filter survives the gate.
  expect(byKey.get('gen_ai.request.model')).toEqual({ requestedModelId: 'claude-sonnet-4-6' });
});

// Every span already in the store recorded its status under the deprecated key. Without the
// legacy entry a historical root span's status code offers no "filter by final status" action.
test('offers the final-status filter for a root span that recorded the legacy status key', () => {
  const legacy = new Map(
    toSpanAttributeRows({ 'http.status_code': 503 }, '', true).map((row) => [row.key, row.filter]),
  );

  expect(legacy.get('http.status_code')).toEqual({ finalHttpStatus: 503 });
  // Same attempt-span gate as the current key: a 503 hop inside a 200 trace must not offer it.
  expect(
    new Map(toSpanAttributeRows({ 'http.status_code': 503 }, '', false).map((row) => [row.key, row.filter])).get(
      'http.status_code',
    ),
  ).toBeUndefined();
});
