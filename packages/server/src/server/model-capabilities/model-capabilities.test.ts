import { expect, test } from 'bun:test';

import type { ModelsDevModel } from '@aio-proxy/core';

import { toAnthropicCapabilities } from './model-capabilities';

const model = (overrides: Partial<ModelsDevModel>): ModelsDevModel => ({
  attachment: false,
  description: '',
  id: 'm',
  last_updated: '2026-01-15',
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ['text'], output: ['text'] },
  name: 'M',
  open_weights: false,
  reasoning: false,
  release_date: '2026-01-15',
  tool_call: false,
  ...overrides,
});

test('derives the Anthropic capabilities shape from raw models.dev signals', () => {
  const capabilities = toAnthropicCapabilities(
    model({
      reasoning: true,
      reasoning_options: [
        { type: 'effort', values: ['low', 'medium', 'high'] },
        { type: 'budget_tokens', min: 1_024 },
      ],
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      structured_output: true,
    }),
  );
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
  const capabilities = toAnthropicCapabilities(
    model({ reasoning: false, modalities: { input: ['text'], output: ['text'] } }),
  );
  expect(capabilities.effort.supported).toBe(false);
  expect(capabilities.thinking.supported).toBe(false);
  expect(capabilities.image_input.supported).toBe(false);
});
