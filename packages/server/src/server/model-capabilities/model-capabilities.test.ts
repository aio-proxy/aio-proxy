import { expect, test } from 'bun:test';

import type { ModelsDevModel } from '@aio-proxy/core';

import { toAnthropicCapabilities, toAnthropicCapabilitiesFromMetadata } from './model-capabilities';

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

test('derives Anthropic capabilities from merged metadata, honoring config overrides', () => {
  const meta = {
    capabilities: {
      reasoning: true,
      structuredOutput: false, // config override: catalog might say true
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    },
  } as const;
  const caps = toAnthropicCapabilitiesFromMetadata(meta);
  expect(caps.structured_outputs).toEqual({ supported: false });
  expect(caps.image_input).toEqual({ supported: true });
  expect(caps.pdf_input).toEqual({ supported: true });
  expect(caps.thinking.supported).toEqual({ supported: true }.supported);
  expect(caps.effort.supported).toBe(true);
  expect(caps.effort.high).toEqual({ supported: true });
  expect(caps.effort.medium).toEqual({ supported: false });
});

test('metadata with no capabilities yields all-unsupported subset', () => {
  const caps = toAnthropicCapabilitiesFromMetadata({});
  expect(caps.structured_outputs).toEqual({ supported: false });
  expect(caps.effort.supported).toBe(false);
  expect(caps.thinking.supported).toBe(false);
});

test('a budgetTokens reasoning option marks thinking.types.enabled supported', () => {
  const caps = toAnthropicCapabilitiesFromMetadata({
    capabilities: { reasoningOptions: [{ type: 'budgetTokens', min: 1024 }] },
  });
  expect(caps.thinking.types.enabled).toEqual({ supported: true });
});

test('an effort-only reasoning option leaves thinking.types.enabled unsupported', () => {
  const caps = toAnthropicCapabilitiesFromMetadata({
    capabilities: { reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] },
  });
  expect(caps.thinking.types.enabled).toEqual({ supported: false });
});
