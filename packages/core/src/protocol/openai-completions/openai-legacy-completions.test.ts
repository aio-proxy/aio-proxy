import { expect, test } from 'bun:test';

import { OpenAICompletionsUnsupportedFeatureError } from '../../error';
import { parseOpenAILegacyCompletions } from '../../ingress/openai-legacy-completions';
import { openAICompletionsErrors } from '../errors';
import { openAILegacyCompletionsAdapter } from './openai-legacy-completions';

function parse(body: Record<string, unknown>) {
  return parseOpenAILegacyCompletions({ model: 'davinci', ...body });
}

function invoke(body: Record<string, unknown>) {
  return openAILegacyCompletionsAdapter.modelInvocation(parse(body), {});
}

test('converts a single string prompt to one user message and omits stream and user', () => {
  const invocation = invoke({
    prompt: 'hello',
    n: null,
    best_of: null,
    temperature: null,
    user: 'u1',
    stream: false,
  });
  expect(invocation.messages).toEqual([{ role: 'user', content: 'hello' }]);
  expect(invocation.settings).toEqual({});
  expect(openAILegacyCompletionsAdapter.wantsStream(parse({ stream: true }), {})).toBe(true);
  expect(openAILegacyCompletionsAdapter.wantsStream(parse({ stream: null }), {})).toBe(false);
});

test.each([
  [{}, 'prompt_omitted', 'prompt'],
  [{ prompt: null }, 'prompt_omitted', 'prompt'],
  [{ prompt: ['a', 'b'] }, 'prompt_array', 'prompt'],
  [{ prompt: [1, 2] }, 'prompt_tokens', 'prompt'],
  [{ prompt: 'x', n: 2 }, 'n', 'n'],
  [{ prompt: 'x', stop: '\n' }, 'stop', 'stop'],
  [{ prompt: 'x', echo: true }, 'echo', 'echo'],
  [{ prompt: 'x', suffix: 'tail' }, 'suffix', 'suffix'],
  [{ prompt: 'x', logprobs: 0 }, 'logprobs', 'logprobs'],
  [{ prompt: 'x', best_of: 2 }, 'best_of', 'best_of'],
  [{ prompt: 'x', logit_bias: { '1': 1 } }, 'logit_bias', 'logit_bias'],
  [{ prompt: 'x', stream_options: { include_usage: true } }, 'stream_options', 'stream_options'],
] as const)('501s %s from modelInvocation', async (body, feature, path) => {
  expect(() => invoke(body)).toThrow(new OpenAICompletionsUnsupportedFeatureError(feature, path));
  try {
    invoke(body);
  } catch (error) {
    const response = openAICompletionsErrors.modelUnsupported?.(error);
    expect(response?.status).toBe(501);
    expect(JSON.stringify(await response?.json())).toContain(feature);
  }
});

test('one-element string array is one prompt and n/best_of null do not 501', () => {
  expect(invoke({ prompt: ['hello'], n: null, best_of: null }).messages).toEqual([{ role: 'user', content: 'hello' }]);
});
