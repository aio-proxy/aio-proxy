import { expect, test } from '@rstest/core';

import { formatDuration } from './format-duration';

test.each([
  [0, '0 ms'],
  [0.125, '0.125 ms'],
  [999, '999 ms'],
  [1_000, '1 s'],
  [20_090, '20.09 s'],
  [59_990, '59.99 s'],
  [60_000, '1 min'],
  [90_000, '1.5 min'],
  [3_600_000, '1 h'],
  [5_400_000, '1.5 h'],
  [86_400_000, '1 d'],
])('formats %d milliseconds as %s', (milliseconds, expected) => {
  expect(formatDuration(milliseconds, 'en-US')).toBe(expected);
});

test('localizes the number while keeping compact unit symbols', () => {
  expect(formatDuration(20_090, 'de-DE')).toBe('20,09 s');
  expect(formatDuration(90_000, 'zh-Hans')).toBe('1.5 min');
});
