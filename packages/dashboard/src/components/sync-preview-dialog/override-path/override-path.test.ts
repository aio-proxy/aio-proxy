import { expect, test } from '@rstest/core';

import { formatOverridePath, parseOverridePath } from './override-path';

test('keeps segments the old dot-split alphabet rejected', () => {
  expect(parseOverridePath('limits.timeout')).toEqual(['limits', 'timeout']);
  expect(parseOverridePath('headers.X-Api Key')).toEqual(['headers', 'X-Api Key']);
  expect(parseOverridePath('models./v1/chat')).toEqual(['models', '/v1/chat']);
  expect(parseOverridePath('模型.超时')).toEqual(['模型', '超时']);
});

test('escapes a dot inside a segment', () => {
  expect(parseOverridePath(String.raw`models.gpt-4\.1`)).toEqual(['models', 'gpt-4.1']);
  expect(parseOverridePath(String.raw`a\\b.c`)).toEqual(['a\\b', 'c']);
});

test('rejects a path that names no option', () => {
  expect(parseOverridePath('')).toBeUndefined();
  expect(parseOverridePath('limits.')).toBeUndefined();
  expect(parseOverridePath('.timeout')).toBeUndefined();
  expect(parseOverridePath('limits..timeout')).toBeUndefined();
  // A trailing backslash escapes nothing, so the user is mid-escape.
  expect(parseOverridePath('limits\\')).toBeUndefined();
});

test('round-trips every path the server accepts', () => {
  for (const path of [['limits', 'timeout'], ['gpt-4.1'], ['a\\b'], [' padded '], ['.'], ['\\']]) {
    expect(parseOverridePath(formatOverridePath(path))).toEqual(path);
  }
});
