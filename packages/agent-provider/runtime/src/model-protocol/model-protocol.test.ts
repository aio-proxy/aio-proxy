import { expect, test } from 'bun:test';

import { resolveAgentModelProtocol } from './model-protocol';

test.each([
  ['gpt-5.6', 'openai-responses'],
  ['claude-opus-5', 'anthropic-messages'],
  ['gemini-3.8-flash', 'google-generative-ai'],
  ['grok-4.5', 'openai-completions'],
  ['gpt', 'openai-completions'],
  ['GPT-5.6', 'openai-completions'],
] as const)('routes %s to %s', (modelId, protocol) => {
  expect(resolveAgentModelProtocol(modelId)).toBe(protocol);
});
