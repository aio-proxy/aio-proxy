import { expect, test } from 'bun:test';

import { AiSdkProviderError } from '../error';
import { createProviderV4ImageInvoke } from './provider-v4-image';

function providerV4(imageModel: (modelId: string) => unknown) {
  return {
    specificationVersion: 'v4' as const,
    languageModel() {
      throw new Error('languageModel should not be called');
    },
    imageModel,
    embeddingModel() {
      throw new Error('embeddingModel should not be called');
    },
  };
}

test('forwards n and size to generateImage and never calls languageModel', async () => {
  const imageModel = (modelId: string) => ({ modelId });
  let generateArgs: Record<string, unknown> | undefined;
  const invoke = createProviderV4ImageInvoke('openai', providerV4(imageModel) as never, async (options) => {
    generateArgs = options as Record<string, unknown>;
    return { images: [{ uint8Array: new Uint8Array([1, 2, 3]) }], usage: { inputTokens: 4 } };
  });

  const result = await invoke({
    modelId: 'gpt-image-2',
    invocation: {
      operation: 'generate',
      prompt: 'a cat',
      n: 2,
      size: '1024x1024',
      responseFormat: 'b64_json',
    },
  });

  expect(generateArgs).toMatchObject({
    model: { modelId: 'gpt-image-2' },
    prompt: 'a cat',
    n: 2,
    size: '1024x1024',
  });
  expect(result.images).toEqual([new Uint8Array([1, 2, 3])]);
  expect(result.usage).toEqual({ inputTokens: 4 });
});

test('omits size when invocation has no size so auto is not passed', async () => {
  let generateArgs: Record<string, unknown> | undefined;
  const invoke = createProviderV4ImageInvoke(
    'openai',
    providerV4(() => ({ modelId: 'gpt-image-2' })) as never,
    async (options) => {
      generateArgs = options as Record<string, unknown>;
      return { images: [new Uint8Array([9])] };
    },
  );

  await invoke({
    modelId: 'gpt-image-2',
    invocation: { operation: 'generate', prompt: 'a cat', n: 1, responseFormat: 'b64_json' },
  });

  expect(generateArgs).toBeDefined();
  expect(generateArgs).not.toHaveProperty('size');
});

test('treats string image results as base64 payloads not URLs', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const invoke = createProviderV4ImageInvoke(
    'openai',
    providerV4(() => ({ modelId: 'gpt-image-2' })) as never,
    async () => ({ images: [Buffer.from(bytes).toString('base64')] }),
  );

  const result = await invoke({
    modelId: 'gpt-image-2',
    invocation: { operation: 'generate', prompt: 'a cat', n: 1, responseFormat: 'b64_json' },
  });

  expect(result.images).toEqual([bytes]);
  expect(Buffer.from(result.images[0]!).toString('utf8')).not.toContain('data:');
});

test('wraps generateImage failures with AiSdkProviderError', async () => {
  const invoke = createProviderV4ImageInvoke(
    'openai',
    providerV4(() => ({ modelId: 'gpt-image-2' })) as never,
    async () => {
      throw new Error('upstream image failed');
    },
  );

  const error = await invoke({
    modelId: 'gpt-image-2',
    invocation: { operation: 'generate', prompt: 'a cat', n: 1, responseFormat: 'b64_json' },
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(AiSdkProviderError);
  expect(error).toMatchObject({ providerId: 'openai', message: expect.stringContaining('upstream image failed') });
});
