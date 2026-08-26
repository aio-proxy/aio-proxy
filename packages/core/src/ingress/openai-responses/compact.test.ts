import { expect, test } from 'bun:test';

import { OpenAIResponsesTransformError } from '../../error';
import { parseOpenAIResponsesCompact } from './compact';
import { parseOpenAIResponses } from './index';

test('accepts omitted and null compact input when model is a non-empty string', () => {
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max' }).input).toBeUndefined();
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', input: null }).input).toBeNull();
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', input: [] }).input).toEqual([]);
  expect(parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', input: '' }).model).toBe('gpt-5.1-codex-max');
});

test('create parse still rejects missing input', () => {
  expect(() => parseOpenAIResponses({ model: 'gpt-5.1-codex-max' })).toThrow();
});

test.each([{}, { model: null }, { model: '' }] as const)('400s compact model %s', (body) => {
  expect(() => parseOpenAIResponsesCompact(body)).toThrow(OpenAIResponsesTransformError);
  try {
    parseOpenAIResponsesCompact(body);
  } catch (error) {
    expect(error).toMatchObject({ path: 'model' });
  }
});

test('400s compact stream true and does not treat null model as a wrong JSON type', () => {
  expect(() => parseOpenAIResponsesCompact({ model: 'gpt-5.1-codex-max', stream: true })).toThrow(
    new OpenAIResponsesTransformError('stream'),
  );
  expect(() => parseOpenAIResponsesCompact({ model: null })).not.toThrow(/expected string/i);
});
