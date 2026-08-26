import { expect, test } from 'bun:test';

import type { ProviderV4 } from '@ai-sdk/provider';

import { AiSdkProviderError, EmbeddingConvertUnsupportedError } from '../error';
import { createProviderV4Embed } from './provider-v4';

function providerFixture(): ProviderV4 {
  return { embeddingModel: () => ({}) } as ProviderV4;
}

function distinctOptionValues(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    value: `t${index}`,
    providerOptions: { google: { outputDimensionality: index + 1 } },
  }));
}

test('one-value group calls embed with singular value', async () => {
  const calls: unknown[] = [];
  const embedFn = async (args: { value: string }) => {
    calls.push(args);
    return { embedding: [0.1], usage: { tokens: 3 }, response: { body: {} } };
  };
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: embedFn as never,
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  const result = await run(
    { values: [{ value: 'a', providerOptions: { openai: { dimensions: 8 } } }] },
    { modelId: 'm' },
  );
  expect(calls[0]).toMatchObject({ value: 'a', providerOptions: { openai: { dimensions: 8 } } });
  expect(result.usage).toEqual({ tokens: 3 });
});

test('2048 values that share one providerOptions object call embedMany once', async () => {
  const providerOptions = {
    openai: { user: 'u'.repeat(4096) },
    openaiCompatible: { user: 'u'.repeat(4096) },
  };
  const calls: Array<{ values: string[] }> = [];
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: async (args: { values: string[] }) => {
      calls.push(args);
      return {
        embeddings: args.values.map(() => [0.1]),
        usage: { tokens: args.values.length },
        responses: [{ body: {} }],
      };
    },
  });
  const values = Array.from({ length: 2048 }, (_, index) => ({ value: `t${index}`, providerOptions }));
  const result = await run({ values }, { modelId: 'm' });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.values).toHaveLength(2048);
  expect(result.embeddings).toHaveLength(2048);
});

test('groups equal providerOptions even when namespace key order differs', async () => {
  const calls: Array<{ values: string[] }> = [];
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: async (args: { values: string[] }) => {
      calls.push(args);
      return { embeddings: [[0.1], [0.2]], usage: { tokens: 4 }, responses: [{ body: {} }] };
    },
  });
  const result = await run(
    {
      values: [
        { value: 'a', providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' }, openai: { dimensions: 8 } } },
        { value: 'b', providerOptions: { openai: { dimensions: 8 }, google: { taskType: 'RETRIEVAL_QUERY' } } },
      ],
    },
    { modelId: 'm' },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.values).toEqual(['a', 'b']);
  expect(result.embeddings).toEqual([[0.1], [0.2]]);
});

test('keeps distinct providerOptions in separate groups', async () => {
  const calls: Array<{ value?: string; values?: string[] }> = [];
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async (args: { value: string }) => {
      calls.push(args);
      return { embedding: [0.1], usage: { tokens: 1 }, response: { body: {} } };
    },
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  const values = Array.from({ length: 8 }, (_, index) => ({
    value: `t${index}`,
    providerOptions: { google: { outputDimensionality: index + 1 } },
  }));
  const result = await run({ values }, { modelId: 'm' });
  expect(calls).toHaveLength(8);
  expect(result.embeddings).toHaveLength(8);
});

test('dispatches the maximum number of distinct option groups', async () => {
  const calls: unknown[] = [];
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async (args: { value: string }) => {
      calls.push(args);
      return { embedding: [0.1], usage: { tokens: 1 }, response: { body: {} } };
    },
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  const result = await run({ values: distinctOptionValues(100) }, { modelId: 'm' });
  expect(calls).toHaveLength(100);
  expect(result.embeddings).toHaveLength(100);
});

test('rejects more than 100 distinct option groups before calling the SDK', async () => {
  let called = false;
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      called = true;
      throw new Error('embed');
    },
    embedMany: async () => {
      called = true;
      throw new Error('embedMany');
    },
  });
  await expect(run({ values: distinctOptionValues(101) }, { modelId: 'm' })).rejects.toMatchObject({
    feature: 'distinct-option groups',
  });
  expect(called).toBe(false);
});

test('multi-value group calls embedMany with values', async () => {
  const embedManyFn = async (args: { values: string[] }) => {
    expect(args.values).toEqual(['a', 'b']);
    return { embeddings: [[0.1], [0.2]], usage: { tokens: 4 }, responses: [{ body: {} }] };
  };
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: embedManyFn as never,
  });
  const result = await run({ values: [{ value: 'a' }, { value: 'b' }] }, { modelId: 'm' });
  expect(result.embeddings).toEqual([[0.1], [0.2]]);
});

test('sums Google usageMetadata across every embedMany response when SDK usage is undefined', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: async () =>
      ({
        embeddings: [[0.1], [0.2]],
        usage: { tokens: Number.NaN },
        responses: [
          { body: { usageMetadata: { promptTokenCount: 3 } } },
          { body: { usageMetadata: { promptTokenCount: 5 } } },
        ],
      }) as never,
  });
  expect((await run({ values: [{ value: 'a' }, { value: 'b' }] }, { modelId: 'm' })).usage).toEqual({ tokens: 8 });
});

test('unsets embedMany fallback usage when any response count is missing', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: async () =>
      ({
        embeddings: [[0.1], [0.2]],
        usage: { tokens: Number.NaN },
        responses: [{ body: { usageMetadata: { promptTokenCount: 3 } } }, { body: {} }],
      }) as never,
  });
  expect((await run({ values: [{ value: 'a' }, { value: 'b' }] }, { modelId: 'm' })).usage).toBeUndefined();
});

test('unsets embedMany fallback usage when the summed counts overflow', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: async () =>
      ({
        embeddings: [[0.1], [0.2]],
        usage: { tokens: Number.NaN },
        responses: [
          { body: { usageMetadata: { promptTokenCount: Number.MAX_SAFE_INTEGER } } },
          { body: { usageMetadata: { promptTokenCount: 1 } } },
        ],
      }) as never,
  });
  expect((await run({ values: [{ value: 'a' }, { value: 'b' }] }, { modelId: 'm' })).usage).toBeUndefined();
});

test('recovers Google usageMetadata when SDK usage is undefined', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () =>
      ({
        embedding: [0.1],
        usage: { tokens: Number.NaN },
        response: { body: { usageMetadata: { promptTokenCount: 9 } } },
      }) as never,
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  expect((await run({ values: [{ value: 'a' }] }, { modelId: 'm' })).usage).toEqual({ tokens: 9 });
});

test('unsets usage when each group is valid but the sum overflows MAX_SAFE_INTEGER', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async ({ value }: { value: string }) =>
      ({
        embedding: [0.1],
        usage: { tokens: value === 'a' ? Number.MAX_SAFE_INTEGER : 1 },
        response: { body: {} },
      }) as never,
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  const result = await run(
    {
      values: [
        { value: 'a', providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } } },
        { value: 'b', providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } } },
      ],
    },
    { modelId: 'm' },
  );
  expect(result.usage).toBeUndefined();
  expect(result.embeddings).toHaveLength(2);
});

test('throws title unsupported before calling the SDK', async () => {
  let called = false;
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      called = true;
      throw new Error('embed');
    },
    embedMany: async () => {
      called = true;
      throw new Error('embedMany');
    },
  });
  await expect(
    run({ values: [{ value: 'a', providerOptions: { google: { title: 'doc' } } }] }, { modelId: 'm' }),
  ).rejects.toBeInstanceOf(EmbeddingConvertUnsupportedError);
  await expect(
    run({ values: [{ value: 'a', providerOptions: { google: { title: 'doc' } } }] }, { modelId: 'm' }),
  ).rejects.toMatchObject({ feature: 'title' });
  expect(called).toBe(false);
});

test('throws autoTruncate unsupported before calling the SDK', async () => {
  let called = false;
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      called = true;
      throw new Error('embed');
    },
    embedMany: async () => {
      called = true;
      throw new Error('embedMany');
    },
  });
  await expect(
    run({ values: [{ value: 'a', providerOptions: { google: { autoTruncate: true } } }] }, { modelId: 'm' }),
  ).rejects.toMatchObject({ feature: 'autoTruncate' });
  expect(called).toBe(false);
});

test('rejects a batch that returns fewer vectors than inputs', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: (async () => ({ embeddings: [[0.1]], usage: { tokens: 4 }, responses: [{ body: {} }] })) as never,
  });
  await expect(run({ values: [{ value: 'a' }, { value: 'b' }] }, { modelId: 'm' })).rejects.toBeInstanceOf(
    AiSdkProviderError,
  );
});

test('rejects a batch that returns more vectors than inputs', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('embed');
    },
    embedMany: (async () => ({
      embeddings: [[0.1], [0.2], [0.3]],
      usage: { tokens: 4 },
      responses: [{ body: {} }],
    })) as never,
  });
  await expect(run({ values: [{ value: 'a' }, { value: 'b' }] }, { modelId: 'm' })).rejects.toMatchObject({
    cause: { expected: 2, received: 3 },
  });
});

test('wraps thrown SDK errors in AiSdkProviderError', async () => {
  const run = createProviderV4Embed('p', providerFixture(), {
    embed: async () => {
      throw new Error('upstream');
    },
    embedMany: async () => {
      throw new Error('embedMany');
    },
  });
  await expect(run({ values: [{ value: 'a' }] }, { modelId: 'm' })).rejects.toBeInstanceOf(AiSdkProviderError);
});
