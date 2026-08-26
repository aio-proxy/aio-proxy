import { expect, test } from 'bun:test';

import { ZodError } from 'zod';

import { parseOpenAILegacyCompletions } from './openai-legacy-completions';

test.each([
  [{}, 'omitted'],
  [{ prompt: null }, 'null'],
  [{ prompt: '' }, 'empty string'],
  [{ prompt: 'hello' }, 'string'],
  [{ prompt: ['only'] }, 'one-element string array'],
  [{ prompt: ['a', 'b'] }, 'multi string array'],
  [{ prompt: [1, 2, 3] }, 'token array'],
  [{ prompt: [[1, 2], [3]] }, 'array of token arrays'],
  [{ n: 2 }, 'n > 1'],
  [{ n: null }, 'n null'],
  [{ best_of: null }, 'best_of null'],
  [{ logprobs: 0 }, 'logprobs 0'],
  [{ stream_options: { include_usage: true } }, 'stream_options'],
] as const)('accepts official Completions %s', (extra, _label) => {
  const parsed = parseOpenAILegacyCompletions({ model: 'davinci', ...extra });
  expect(parsed.model).toBe('davinci');
  if (!('prompt' in extra)) expect(parsed.prompt).toBeUndefined();
  else expect(parsed.prompt).toEqual(extra.prompt);
});

test('does not rewrite omitted prompt to empty string', () => {
  const parsed = parseOpenAILegacyCompletions({ model: 'davinci' });
  expect('prompt' in parsed && parsed.prompt === '').toBe(false);
});

test('rejects empty model and does not reject official option shapes', () => {
  expect(() => parseOpenAILegacyCompletions({ model: '' })).toThrow(ZodError);
  expect(() => parseOpenAILegacyCompletions({ model: 'davinci', n: 4, stop: ['\n'] })).not.toThrow();
});
