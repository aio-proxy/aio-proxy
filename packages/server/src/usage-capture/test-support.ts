import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, type TextStreamPart, type ToolSet } from '@aio-proxy/core';

// Pricing now resolves through getProviders()'s fileCacheStorage (keyed off
// AIO_PROXY_HOME) rather than an injected catalog. Seed the OpenRouter cost map
// an isolated home so each test controls exactly which prices findModelPrice
// sees, then restore the home and clear caches afterwards.
type SeedPrice = {
  readonly id: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
};

const originalPriceHome = { value: process.env.AIO_PROXY_HOME };
let seededPriceHome: string | undefined;

export async function seedPriceCatalog(prices: readonly SeedPrice[]): Promise<void> {
  seededPriceHome = mkdtempSync(join(tmpdir(), 'aio-proxy-price-'));
  originalPriceHome.value = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = seededPriceHome;
  clearModelsCache();
  const models = Object.fromEntries(
    prices.map((price) => [
      price.id,
      {
        id: price.id,
        cost: {
          input: price.input,
          output: price.output,
          ...(price.cacheRead === undefined ? {} : { cache_read: price.cacheRead }),
          ...(price.cacheWrite === undefined ? {} : { cache_write: price.cacheWrite }),
          ...(price.reasoning === undefined ? {} : { reasoning: price.reasoning }),
        },
      },
    ]),
  );
  await fileCacheStorage.setItem('models-dev-providers', { openrouter: { models } });
}

export function clearPriceCatalog(): void {
  clearModelsCache();
  if (seededPriceHome !== undefined) {
    rmSync(seededPriceHome, { force: true, recursive: true });
    seededPriceHome = undefined;
  }
  if (originalPriceHome.value === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = originalPriceHome.value;
}

export function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

export function finishPart(): TextStreamPart<ToolSet> {
  return {
    type: 'finish',
    finishReason: 'stop',
    rawFinishReason: 'stop',
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 1, noCacheTokens: 1 },
      inputTokens: 4,
      outputTokenDetails: { reasoningTokens: 3, textTokens: 3 },
      outputTokens: 6,
      totalTokens: 10,
    },
  };
}

export async function drain<T>(stream: ReadableStream<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
