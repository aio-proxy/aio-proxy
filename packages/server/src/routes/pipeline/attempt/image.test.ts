import { expect, test } from 'bun:test';

import { defineImageProtocolAdapter } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import {
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
  textStream,
  type FakeProvider,
} from '../../../../__tests__/pipeline-helpers';
import type {
  ImageTransport,
  ImageTransportInvokeRequest,
  ModelTransport,
  RuntimeProviderInstance,
} from '../../../runtime';
import { pipeline } from '../test-support';

function imageAdapter() {
  return defineImageProtocolAdapter({
    protocol: ProviderProtocol.OpenAIImage,
    async parse(raw, context) {
      context.parseCalls += 1;
      const value: unknown = await raw.clone().json();
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !('model' in value) ||
        typeof value.model !== 'string'
      ) {
        throw new SyntaxError('invalid test request');
      }
      return {
        model: value.model,
        prompt: 'prompt' in value && typeof value.prompt === 'string' ? value.prompt : 'ping',
        stream: 'stream' in value && value.stream === true,
      };
    },
    model: (request) => request.model,
    wantsStream: (request) => request.stream,
    async rawRequest(raw, request, resolvedModel, _supportedEfforts, context) {
      context.rawRequestCalls += 1;
      const headers = new Headers(raw.headers);
      headers.delete('content-length');
      return new Request(raw, {
        method: raw.method,
        body: JSON.stringify({ ...request, model: resolvedModel }),
        headers,
      });
    },
    imageInvocation: (request) => ({
      operation: 'generate',
      prompt: request.prompt,
      n: 1,
      responseFormat: 'b64_json',
    }),
    imageJson: async (result) => ({ created: result.created ?? 1, count: result.images.length }),
    errors: {
      requestError: (error) =>
        error instanceof SyntaxError ? Response.json({ error: { code: 'request_error' } }, { status: 400 }) : undefined,
      modelNotFound: (message) => Response.json({ error: { code: 'model_not_found', message } }, { status: 404 }),
      previousResponseConflict: () => Response.json({ error: { code: 'conflict' } }, { status: 409 }),
      tooLarge: () => Response.json({ error: { code: 'too_large' } }, { status: 413 }),
      unsupportedContentEncoding: () => Response.json({ error: { code: 'encoding' } }, { status: 415 }),
      unsupported: (feature) => Response.json({ error: { code: 'unsupported', message: feature } }, { status: 501 }),
      provider: (error) =>
        error instanceof Error
          ? Response.json({ error: { code: 'provider_error', message: error.message } }, { status: 502 })
          : undefined,
      rateLimited: (seconds) => {
        const response = Response.json({ error: { code: 'rate_limited' } }, { status: 429 });
        response.headers.set('retry-after', String(Math.max(1, Math.trunc(seconds))));
        return response;
      },
    },
  });
}

function withImageIndex(fixture: FakeProvider): FakeProvider {
  const modelIds = Object.keys(fixture.provider.capabilityIndex);
  return {
    ...fixture,
    provider: {
      ...fixture.provider,
      capabilityIndex: Object.fromEntries(modelIds.map((id) => [id, new Set(['image'] as const)])),
    },
  };
}

function convertProvider(options: {
  readonly id: string;
  readonly invoke?: ImageTransport['invoke'];
  readonly modelInvoke?: ModelTransport['invoke'];
}): FakeProvider & { readonly imageCalls: ImageTransportInvokeRequest[] } {
  const imageCalls: ImageTransportInvokeRequest[] = [];
  const calls: FakeProvider['calls'] = { ensure: 0, model: [], raw: [] };
  const modelId = `${options.id}-model`;
  const provider = {
    alias: { [REQUESTED_MODEL]: { model: modelId, preserve: false } },
    capabilityIndex: { [modelId]: new Set(['image'] as const) },
    enabled: true,
    id: options.id,
    kind: ProviderKind.AiSdk,
    image: {
      async invoke(request: ImageTransportInvokeRequest) {
        imageCalls.push(request);
        return options.invoke?.(request) ?? { images: [new Uint8Array([1, 2, 3])], usage: { inputTokens: 11 } };
      },
    },
    ...(options.modelInvoke === undefined
      ? {}
      : {
          model: {
            invoke(request: Parameters<ModelTransport['invoke']>[0]) {
              calls.model.push(request);
              return options.modelInvoke!(request);
            },
          },
        }),
  } satisfies RuntimeProviderInstance;
  return { calls, imageCalls, provider };
}

test('image inbound uses raw when openai-image resolves', async () => {
  const raw = withImageIndex(
    rawProvider({
      id: 'raw',
      protocol: ProviderProtocol.OpenAIImage,
      invoke: async () => Response.json({ provider: 'raw' }),
    }),
  );
  const route = pipeline([raw], { adapter: imageAdapter() });

  const response = await route.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'a cat', stream: true }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ provider: 'raw' });
  expect(raw.calls.raw).toHaveLength(1);
  expect(route.usage.passthrough[0]?.idleTimeoutMs).toBe(600_000);
  await settleRecording(route.recording);
  expect(route.recording.attempts.map(({ providerId, transport }) => ({ providerId, transport }))).toEqual([
    { providerId: 'raw', transport: 'raw' },
  ]);
});

test('image inbound convert calls image transport not language model', async () => {
  const convert = convertProvider({
    id: 'convert',
    modelInvoke: () => textStream('should not run'),
  });
  const route = pipeline([convert], { adapter: imageAdapter() });

  const response = await route.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'a cat' }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ created: 1, count: 1 });
  expect(convert.imageCalls).toHaveLength(1);
  expect(convert.imageCalls[0]?.modelId).toBe('convert-model');
  expect(convert.imageCalls[0]?.invocation).toMatchObject({
    operation: 'generate',
    prompt: 'a cat',
    n: 1,
    responseFormat: 'b64_json',
  });
  expect(convert.calls.model).toHaveLength(0);
  await settleRecording(route.recording);
  expect(route.recording.attempts.map(({ providerId, transport }) => ({ providerId, transport }))).toEqual([
    { providerId: 'convert', transport: 'image' },
  ]);
  expect(route.recording.finals.at(-1)?.usage?.imageCount).toBe(1);
  expect(route.recording.finals.at(-1)?.usage?.inputTokens).toBe(11);
});

test('image inbound skips dummy convert when stream is true and falls through', async () => {
  const convert = convertProvider({ id: 'convert' });
  const raw = withImageIndex(
    rawProvider({
      id: 'raw',
      protocol: ProviderProtocol.OpenAIImage,
      invoke: async () => Response.json({ provider: 'raw' }),
    }),
  );
  const route = pipeline([convert, raw], { adapter: imageAdapter() });

  const response = await route.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'a cat', stream: true }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ provider: 'raw' });
  expect(convert.imageCalls).toHaveLength(0);
  expect(raw.calls.raw).toHaveLength(1);
  await settleRecording(route.recording);
  expect(route.recording.attempts.map(({ providerId, transport }) => ({ providerId, transport }))).toEqual([
    { providerId: 'raw', transport: 'raw' },
  ]);
});

test('language inbound never calls image transport', async () => {
  const imageCalls: ImageTransportInvokeRequest[] = [];
  const language = modelProvider({ id: 'lang', invoke: () => textStream('ok') });
  const route = pipeline([
    {
      ...language,
      provider: {
        ...language.provider,
        image: {
          async invoke(request) {
            imageCalls.push(request);
            return { images: [new Uint8Array([1])] };
          },
        },
      },
    },
  ]);

  const response = await route.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'hello' }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: 'ok' });
  expect(imageCalls).toHaveLength(0);
  expect(language.calls.model).toHaveLength(1);
});
