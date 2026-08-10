import { expect, test } from 'bun:test';

import { fromWireName, toWireName } from './tool-names';

test('escapes only reserved caller names and round-trips them', () => {
  expect(toWireName('read')).toBe('aio_proxy__read');
  expect(fromWireName('aio_proxy__read')).toBe('read');
  expect(toWireName('search_docs')).toBe('search_docs');
  expect(fromWireName('search_docs')).toBe('search_docs');
});

test('does not strip the prefix when the remainder is not reserved', () => {
  expect(fromWireName('aio_proxy__search')).toBe('aio_proxy__search');
});

test.each([
  ['read', 'aio_proxy__read'],
  ['aio_proxy__read', 'aio_proxy__aio_proxy__read'],
  ['aio_proxy__aio_proxy__read', 'aio_proxy__aio_proxy__aio_proxy__read'],
  ['aio_proxy__search', 'aio_proxy__aio_proxy__search'],
] as const)('round-trips the literal caller tool name %s', (callerName, wireName) => {
  expect(toWireName(callerName)).toBe(wireName);
  expect(fromWireName(wireName)).toBe(callerName);
});

test('matching is case-sensitive', () => {
  expect(toWireName('Read')).toBe('Read');
});
