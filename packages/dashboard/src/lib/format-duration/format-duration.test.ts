import { expect, test } from '@rstest/core';

import { formatDuration } from './format-duration';

test.each([
  [0, '0 ms'],
  [0.125, '0.125 ms'],
  [999, '999 ms'],
  [999.999, '999.999 ms'],
  [999.9996, '1 sec'],
  [1_000, '1 sec'],
  [20_090, '20.09 sec'],
  [59_990, '59.99 sec'],
  [59_994, '59.99 sec'],
  [59_995, '1 min'],
  [59_999, '1 min'],
  [60_000, '1 min'],
  [90_000, '1.5 min'],
  [3_599_699, '59.99 min'],
  [3_599_700, '1 hr'],
  [3_599_999, '1 hr'],
  [3_600_000, '1 hr'],
  [5_400_000, '1.5 hr'],
  [86_381_999, '23.99 hr'],
  [86_382_000, '1 day'],
  [86_400_000, '1 day'],
])('formats %d milliseconds without overflowing a rounded unit as %s', (milliseconds, expected) => {
  expect(formatDuration(milliseconds, 'en-US')).toBe(expected);
});

test.each([
  ['zh-Hans', 125, '125毫秒'],
  ['zh-Hans', 20_090, '20.09秒'],
  ['zh-Hans', 90_000, '1.5分钟'],
  ['zh-Hans', 5_400_000, '1.5小时'],
  ['zh-Hans', 86_400_000, '1天'],
  ['zh-Hant', 20_090, '20.09秒'],
  ['zh-Hant', 90_000, '1.5分鐘'],
  ['zh-Hant', 5_400_000, '1.5小時'],
  ['ja', 90_000, '1.5分'],
  ['ko', 20_090, '20.09초'],
  ['de-DE', 20_090, '20,09 Sek.'],
])('localizes the number and duration unit for %s', (locale, milliseconds, expected) => {
  // ICU versions differ in spacing between numbers and localized units.
  expect(formatDuration(milliseconds, locale).replace(/\s/gu, '')).toBe(expected.replace(/\s/gu, ''));
});
