import { expect, test } from 'bun:test';

import type { AgentCatalogV1 } from '@aio-proxy/types';

import { openCodeCatalogDigest, toOpenCodeModels } from './catalog';

const catalog = (overrides: Partial<AgentCatalogV1['models'][number]> = {}): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'opencode',
  models: [
    {
      id: 'gpt-x',
      name: 'GPT X',
      reasoning: true,
      tool_call: false,
      temperature: true,
      attachment: true,
      input: ['text', 'image', 'pdf'],
      context_window: 200_000,
      max_output_tokens: 64_000,
      ...overrides,
    },
  ],
});

test('maps every schema-1 capability without adapter-side guessing', () => {
  expect(toOpenCodeModels(catalog())).toEqual({
    'gpt-x': {
      name: 'GPT X',
      reasoning: true,
      tool_call: false,
      temperature: true,
      attachment: true,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      limit: { context: 200_000, output: 64_000 },
    },
  });
});

test('fills OpenCode-required numeric limits only when the wire value is null', () => {
  expect(toOpenCodeModels(catalog({ context_window: null, max_output_tokens: null }))['gpt-x']?.limit).toEqual({
    context: 128_000,
    output: 32_768,
  });
  expect(toOpenCodeModels(catalog({ context_window: 8_000, max_output_tokens: null }))['gpt-x']?.limit).toEqual({
    context: 8_000,
    output: 8_000,
  });
});

test('digest changes only when ordered model content changes', () => {
  const first = catalog();
  expect(openCodeCatalogDigest(first)).toBe(openCodeCatalogDigest(structuredClone(first)));
  expect(openCodeCatalogDigest(first)).not.toBe(openCodeCatalogDigest(catalog({ name: 'Renamed' })));
  expect(openCodeCatalogDigest(null)).toBe('missing');
});
