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

test('matching is case-sensitive', () => {
  expect(toWireName('Read')).toBe('Read');
});
