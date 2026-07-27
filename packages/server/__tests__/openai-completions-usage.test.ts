import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';

import {
  chatRequest,
  createTempHomes,
  mockModelsDevCatalog,
  restoreFetch,
  textStream,
  waitForUsageRow,
} from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);
const homes = createTempHomes('aio-proxy-openai-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('POST /v1/chat/completions', () => {
  test('Given ai-sdk provider returns usage When completion finishes Then dashboard overview includes it', async () => {
    // Given
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      invoke() {
        return textStream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', text: 'Hel' },
          { type: 'text-delta', id: 'text-1', text: 'lo' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: {
              inputTokenDetails: {
                noCacheTokens: undefined,
                cacheReadTokens: undefined,
                cacheWriteTokens: undefined,
              },
              inputTokens: 3,
              outputTokenDetails: {
                textTokens: undefined,
                reasoningTokens: undefined,
              },
              outputTokens: 2,
              totalTokens: 5,
            },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();

    // Then
    expect(await waitForUsageRow(app)).toEqual({
      range: '24h',
      metric: 'tokens',
      groupBy: 'provider',
      rangeStart: expect.any(String),
      rangeEnd: expect.any(String),
      bucketUnit: 'hour',
      summary: expect.objectContaining({
        inputTokens: '3',
        outputTokens: '2',
        requestCount: '1',
        totalTokens: '5',
      }),
      series: [{ key: 'mock-ai', kind: 'dimension' }],
      buckets: expect.any(Array),
    });
  });
});
