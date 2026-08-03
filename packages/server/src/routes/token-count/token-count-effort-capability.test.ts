import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage } from '@aio-proxy/core';
import type { TokenCountInput } from '@aio-proxy/plugin-sdk';
import { ProviderProtocol } from '@aio-proxy/types';

import { countFixture, openAIResponsesRequest, provider } from './token-count.test-support';

// The candidate resolves to the bare wire id `${id}-wire`; seed it under the
// OpenRouter fallback (resolveModel matches a bare id there) with effort
// advertised only through `high`, forcing xhigh to clamp down.
const providerMap = {
  openrouter: {
    doc: 'https://example.com/openrouter',
    env: [],
    id: 'openrouter',
    name: 'openrouter',
    npm: '@ai-sdk/openrouter',
    models: {
      'responses-wire': {
        attachment: false,
        description: '',
        id: 'responses-wire',
        last_updated: '2026-01-15',
        limit: { context: 128_000, output: 8_000 },
        modalities: { input: ['text'], output: ['text'] },
        name: 'responses-wire',
        open_weights: false,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
        release_date: '2026-01-15',
        tool_call: false,
      },
    },
  },
};

const original = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'aio-proxy-tc-effort-'));
  process.env.AIO_PROXY_HOME = home;
  await fileCacheStorage.setItem('models-dev-providers', providerMap);
  clearModelsCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

test('clamps adaptive effort to the candidate capabilities before counting', async () => {
  // Regression: the token-count path must resolve the candidate's real supported
  // efforts, exactly like the generation path. Passing an empty set left xhigh
  // untouched, which providers validating private efforts reject — the count
  // then throws and silently falls back to a local estimate.
  let counted: TokenCountInput['invocation'] | undefined;
  const fixture = countFixture([
    provider({
      id: 'responses',
      targetProtocol: ProviderProtocol.OpenAIResponse,
      tokenCount: async ({ invocation }) => {
        counted = invocation;
        return { inputTokens: 7 };
      },
    }),
  ]);

  const response = await fixture.openAIResponses(openAIResponsesRequest({ reasoning: { effort: 'xhigh' } }));

  expect(await response.json()).toEqual({ input_tokens: 7 });
  expect(counted?.settings?.reasoning).toBe('high');
});
