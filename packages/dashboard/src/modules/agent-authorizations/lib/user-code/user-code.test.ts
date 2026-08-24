import { expect, test } from '@rstest/core';

import { normalizeAgentUserCode } from './user-code';

test.each([
  ['', ''],
  ['ab c-23de', 'ABC2-3DE'],
  ['abcd2345extra', 'ABCD-2345'],
  ['a!b@c#d$', 'ABCD'],
  ['io10abcd', 'ABCD'],
])('normalizes %j to %j without accepting more than eight symbols', (input, expected) => {
  expect(normalizeAgentUserCode(input)).toBe(expected);
});
