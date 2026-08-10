import { expect, test } from 'bun:test';

import { locales } from '../paraglide/runtime';
import { dateFnsLocale } from './date-fns-locale';

test('maps every app locale to a matching date-fns locale', () => {
  expect(locales).toEqual(['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']);
  expect(dateFnsLocale('en').code).toBe('en-US');
  expect(dateFnsLocale('zh-Hans').code).toBe('zh-CN');
  expect(dateFnsLocale('zh-Hant').code).toBe('zh-TW');
  expect(dateFnsLocale('ja').code).toBe('ja');
  expect(dateFnsLocale('ko').code).toBe('ko');
});
