import { expect, test } from 'bun:test';

import { ZodError } from 'zod';

import {
  CPA_DEFAULT_IMAGE_MODEL,
  imageConvertSkipReason,
  openAIImagesAdapter,
  openAIImagesErrors,
  type OpenAIImageRequest,
} from './openai-image';

const generations = { operation: 'generations' as const };
const edits = { operation: 'edits' as const };

function generationsRequest(body: unknown): Request {
  return new Request('https://x/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseGenerations(body: unknown): Promise<OpenAIImageRequest> {
  return openAIImagesAdapter.parse(generationsRequest(body), generations);
}

test('adapter model returns the CPA lookup id after defaulting', async () => {
  const request = await parseGenerations({ prompt: 'a cat' });
  expect(openAIImagesAdapter.model(request, generations)).toBe(CPA_DEFAULT_IMAGE_MODEL);
  expect(request.modelDefaulted).toBe(true);
});

test.each([
  ['omitted', { prompt: 'a cat' }],
  ['JSON null', { model: null, prompt: 'a cat' }],
  ['empty string', { model: '', prompt: 'a cat' }],
  ['whitespace', { model: '   ', prompt: 'a cat' }],
] as const)('defaults %s model; raw and convert use gpt-image-2 when unresolved', async (_name, body) => {
  const raw = generationsRequest(body);
  const request = await openAIImagesAdapter.parse(raw, generations);
  expect(request.model).toBe('gpt-image-2');
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), generations);
  expect(await forwarded.json()).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat' });
  expect(openAIImagesAdapter.imageInvocation(request, generations)).toMatchObject({
    operation: 'generate',
    prompt: 'a cat',
    n: 1,
    responseFormat: 'b64_json',
  });
});

test('rewrites a defaulted request to the resolved alias target', async () => {
  const raw = generationsRequest({ prompt: 'a cat' });
  const request = await openAIImagesAdapter.parse(raw, generations);
  expect(request.model).toBe('gpt-image-2');
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'acme-image-2', new Set(), generations);
  expect(await forwarded.json()).toMatchObject({ model: 'acme-image-2' });
});

test('forwards explicit same-id raw bytes without a JSON round-trip', async () => {
  const bodyText = '{"model":"gpt-image-2","seed":9007199254740993,"prompt":"a cat"}';
  const raw = new Request('https://x/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });
  const request = await openAIImagesAdapter.parse(raw, generations);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), generations);
  expect(await forwarded.text()).toBe(bodyText);
});

test('rewrites even when the defaulted lookup still resolves to gpt-image-2', async () => {
  const bodyText = '{"prompt":"a cat","seed":42}';
  const raw = new Request('https://x/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });
  const request = await openAIImagesAdapter.parse(raw, generations);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), generations);
  const forwardedText = await forwarded.text();
  expect(forwardedText).not.toBe(bodyText);
  expect(JSON.parse(forwardedText)).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat', seed: 42 });
});

test('treats convert null optional fields as omitted while raw keeps the nulls', async () => {
  const body = {
    prompt: 'a cat',
    n: null,
    size: null,
    quality: null,
    response_format: null,
    stream: null,
    partial_images: null,
  };
  const raw = generationsRequest(body);
  const request = await openAIImagesAdapter.parse(raw, generations);
  expect(request.n).toBeNull();
  expect(request.size).toBeNull();
  expect(request.quality).toBeNull();
  expect(request.response_format).toBeNull();
  expect(request.stream).toBeNull();
  expect(request.partial_images).toBeNull();
  const invocation = openAIImagesAdapter.imageInvocation(request, generations);
  expect(invocation.n).toBe(1);
  expect(invocation.size).toBeUndefined();
  expect(invocation.providerOptions).toBeUndefined();
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), generations);
  expect(await forwarded.json()).toMatchObject(body);
});

test('omits convert size for auto and passes width x height', async () => {
  const autoRequest = await parseGenerations({ prompt: 'a cat', size: 'auto' });
  expect(openAIImagesAdapter.imageInvocation(autoRequest, generations).size).toBeUndefined();
  const sized = await parseGenerations({ prompt: 'a cat', size: '1024x1024' });
  expect(openAIImagesAdapter.imageInvocation(sized, generations).size).toBe('1024x1024');
});

test('copies present provider options and drops unknown fields on convert', async () => {
  const request = await parseGenerations({
    prompt: 'a cat',
    quality: 'high',
    output_format: 'webp',
    output_compression: 50,
    background: 'opaque',
    moderation: 'low',
    style: 'vivid',
    user: 'u1',
    extra: 'drop-me',
  });
  expect(request).not.toHaveProperty('extra');
  expect(openAIImagesAdapter.imageInvocation(request, generations).providerOptions).toEqual({
    openai: {
      quality: 'high',
      output_format: 'webp',
      output_compression: 50,
      background: 'opaque',
      moderation: 'low',
      style: 'vivid',
      user: 'u1',
    },
  });
});

test('omitted model plus stream true is a stream skip, not a missing-model 400', async () => {
  const request = await parseGenerations({ prompt: 'a cat', stream: true });
  expect(request.model).toBe('gpt-image-2');
  expect(openAIImagesAdapter.wantsStream(request, generations)).toBe(true);
  expect(imageConvertSkipReason({ request, resolvedModelId: 'gpt-image-2' })).toBe('stream');
  const response = openAIImagesErrors.unsupported('stream');
  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({
    error: { code: 'unsupported_feature', type: 'invalid_request_error' },
  });
});

test('mixed alias skip: resolved dall-e-3 with n=2 and requested pool is dall-e-3-n', () => {
  const request = {
    model: 'pool',
    modelDefaulted: false,
    clientModel: 'pool',
    prompt: 'a cat',
    n: 2,
  } satisfies OpenAIImageRequest;
  expect(imageConvertSkipReason({ request, resolvedModelId: 'dall-e-3' })).toBe('dall-e-3-n');
  expect(imageConvertSkipReason({ request, resolvedModelId: 'acme/dall-e-3' })).toBe('dall-e-3-n');
});

test.each(['dall-e-2', 'dall-e-3', 'vendor/dall-e-2'] as const)(
  'DALL·E %s omitted / null / url response_format skips as url',
  (resolvedModelId) => {
    const base = { model: 'pool', modelDefaulted: false, clientModel: 'pool', prompt: 'x', n: null };
    expect(imageConvertSkipReason({ request: base, resolvedModelId })).toBe('response_format=url');
    expect(imageConvertSkipReason({ request: { ...base, response_format: null }, resolvedModelId })).toBe(
      'response_format=url',
    );
    expect(imageConvertSkipReason({ request: { ...base, response_format: 'url' }, resolvedModelId })).toBe(
      'response_format=url',
    );
    expect(
      imageConvertSkipReason({ request: { ...base, response_format: 'b64_json' }, resolvedModelId }),
    ).toBeUndefined();
  },
);

test.each(['gpt-image-2', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'chatgpt-image-latest'] as const)(
  'GPT Image %s omitted / null response_format does not skip',
  (resolvedModelId) => {
    const base = { model: resolvedModelId, modelDefaulted: false, clientModel: resolvedModelId, prompt: 'x', n: null };
    expect(imageConvertSkipReason({ request: base, resolvedModelId })).toBeUndefined();
    expect(imageConvertSkipReason({ request: { ...base, response_format: null }, resolvedModelId })).toBeUndefined();
    expect(imageConvertSkipReason({ request: { ...base, response_format: 'url' }, resolvedModelId })).toBe(
      'response_format=url',
    );
  },
);

test('custom omitted response_format does not skip', () => {
  const request = { model: 'pool', modelDefaulted: false, clientModel: 'pool', prompt: 'x', n: null };
  expect(imageConvertSkipReason({ request, resolvedModelId: 'acme-image' })).toBeUndefined();
  expect(
    imageConvertSkipReason({ request: { ...request, response_format: 'url' }, resolvedModelId: 'acme-image' }),
  ).toBe('response_format=url');
});

test('imageJson encodes b64_json only and copies usage when token fields exist', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const withUsage = await openAIImagesAdapter.imageJson(
    { images: [bytes], created: 1713833628, usage: { input_tokens: 9 } },
    { modelId: 'gpt-image-2' },
  );
  expect(withUsage).toEqual({
    created: 1713833628,
    data: [{ b64_json: Buffer.from(bytes).toString('base64') }],
    usage: { input_tokens: 9 },
  });
  expect(JSON.stringify(withUsage)).not.toContain('"url"');

  const withoutUsage = await openAIImagesAdapter.imageJson(
    { images: [bytes], created: 10 },
    { modelId: 'gpt-image-2' },
  );
  expect(withoutUsage).toEqual({
    created: 10,
    data: [{ b64_json: Buffer.from(bytes).toString('base64') }],
  });
});

test('edits parse rejects until the edits adapter ships', async () => {
  await expect(openAIImagesAdapter.parse(generationsRequest({ prompt: 'a cat' }), edits)).rejects.toBeInstanceOf(
    ZodError,
  );
});

test('maps protocol-shaped Images errors', async () => {
  const missing = openAIImagesErrors.modelNotFound('unknown-model');
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    error: { code: 'model_not_found', message: 'unknown-model', type: 'invalid_request_error' },
  });

  const images = openAIImagesErrors.unsupported('images');
  expect(images.status).toBe(501);
  expect(await images.json()).toEqual({
    error: {
      code: 'not_implemented',
      message: 'No configured provider can generate images for this model',
      type: 'invalid_request_error',
    },
  });

  const stream = openAIImagesErrors.unsupported('stream');
  expect(stream.status).toBe(501);
  expect(await stream.json()).toMatchObject({
    error: { code: 'unsupported_feature', type: 'invalid_request_error' },
  });
});
