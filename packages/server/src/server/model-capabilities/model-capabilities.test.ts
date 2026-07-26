import { expect, test } from 'bun:test';

import { toAnthropicCapabilities } from './model-capabilities';

test('returns null when the metadata row carries no capability signal', () => {
  expect(toAnthropicCapabilities({ displayName: 'x', maxInputTokens: 100 })).toBeNull();
});

test('derives the Anthropic capabilities shape from raw models.dev signals', () => {
  const capabilities = toAnthropicCapabilities({
    reasoning: true,
    reasoning_options: [
      { type: 'effort', values: ['low', 'medium', 'high'] },
      { type: 'budget_tokens', min: 1_024 },
    ],
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    structured_output: true,
  });
  expect(capabilities).toEqual({
    effort: {
      high: { supported: true },
      low: { supported: true },
      max: { supported: false },
      medium: { supported: true },
      supported: true,
      xhigh: { supported: false },
    },
    image_input: { supported: true },
    pdf_input: { supported: true },
    structured_outputs: { supported: true },
    thinking: {
      supported: true,
      types: { adaptive: { supported: true }, enabled: { supported: true } },
    },
  });
});

test('a non-reasoning text-only model reports no effort and no thinking', () => {
  const capabilities = toAnthropicCapabilities({
    reasoning: false,
    modalities: { input: ['text'], output: ['text'] },
  });
  expect(capabilities?.effort.supported).toBe(false);
  expect(capabilities?.thinking.supported).toBe(false);
  expect(capabilities?.image_input.supported).toBe(false);
});
