import { expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';

import { OpenAIImagesInvalidRequestError } from '../../error';
import { REQUEST_BODY_LIMITS } from '../request';
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

function editsRequest(body: unknown): Request {
  return new Request('https://x/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function parseGenerations(body: unknown): Promise<OpenAIImageRequest> {
  return openAIImagesAdapter.parse(generationsRequest(body), generations);
}

async function parseEdits(body: unknown): Promise<OpenAIImageRequest> {
  return openAIImagesAdapter.parse(editsRequest(body), edits);
}

const editsImageUrl = {
  prompt: 'make it night',
  images: [{ image_url: 'https://example.com/cat.png' }],
};

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
  expect(forwarded).toBe(raw);
  expect(await forwarded.text()).toBe(bodyText);
});

test('reuses the original gzip body when the explicit model is unchanged', async () => {
  const bodyText = '{"model":"gpt-image-2","prompt":"a cat"}';
  const encoded = gzipSync(Buffer.from(bodyText));
  const raw = new Request('https://x/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: new Uint8Array(encoded),
  });
  const request = await openAIImagesAdapter.parse(raw, generations);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), generations);
  expect(forwarded).toBe(raw);
  expect(forwarded.headers.get('content-encoding')).toBe('gzip');
  expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(new Uint8Array(encoded));
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

test('rejects a malformed convert size instead of omitting it', async () => {
  const raw = generationsRequest({ prompt: 'a cat', size: 'large' });
  const request = await openAIImagesAdapter.parse(raw, generations);
  expect(request.size).toBe('large');
  expect(() => openAIImagesAdapter.imageInvocation(request, generations)).toThrow(OpenAIImagesInvalidRequestError);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), generations);
  expect(await forwarded.json()).toMatchObject({ size: 'large' });
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
      outputFormat: 'webp',
      outputCompression: 50,
      background: 'opaque',
      moderation: 'low',
      style: 'vivid',
      user: 'u1',
    },
    openaiCompatible: {
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

  const fromSdk = await openAIImagesAdapter.imageJson(
    {
      images: [bytes],
      created: 1713833628,
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, inputTokensDetails: { imageTokens: 3 } },
    },
    { modelId: 'gpt-image-2' },
  );
  expect(fromSdk).toMatchObject({
    usage: {
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6,
      input_tokens_details: { image_tokens: 3 },
    },
  });

  const withoutUsage = await openAIImagesAdapter.imageJson(
    { images: [bytes], created: 10 },
    { modelId: 'gpt-image-2' },
  );
  expect(withoutUsage).toEqual({
    created: 10,
    data: [{ b64_json: Buffer.from(bytes).toString('base64') }],
  });
});

test('JSON edits with image_url parse for raw and convert 501s image_url', async () => {
  const raw = editsRequest(editsImageUrl);
  const request = await openAIImagesAdapter.parse(raw, edits);
  expect(request.prompt).toBe('make it night');
  expect(request.images).toEqual([{ image_url: 'https://example.com/cat.png' }]);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), edits);
  expect(await forwarded.json()).toMatchObject(editsImageUrl);
  expect(imageConvertSkipReason({ request, resolvedModelId: 'gpt-image-2' })).toBe('image_url');
  expect(() => openAIImagesAdapter.imageInvocation(request, edits)).toThrow(/image_url/u);
  const response = openAIImagesErrors.unsupported('image_url');
  expect(response.status).toBe(501);
  expect(await response.json()).toEqual({
    error: {
      code: 'unsupported_feature',
      message: 'OpenAI Images feature is not supported: image_url',
      type: 'invalid_request_error',
    },
  });
});

test('JSON edits file_id convert 501s files', async () => {
  const request = await parseEdits({ prompt: 'make it night', images: [{ file_id: 'file-abc' }] });
  expect(imageConvertSkipReason({ request, resolvedModelId: 'gpt-image-2' })).toBe('files');
  expect(() => openAIImagesAdapter.imageInvocation(request, edits)).toThrow(/files/u);
  const response = openAIImagesErrors.unsupported('files');
  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({
    error: { code: 'unsupported_feature', type: 'invalid_request_error' },
  });
});

test('JSON edits URL mask convert 501s image_url even when images use file_id', async () => {
  const request = await parseEdits({
    prompt: 'make it night',
    images: [{ file_id: 'file-abc' }],
    mask: { image_url: 'https://example.com/mask.png' },
  });
  expect(imageConvertSkipReason({ request, resolvedModelId: 'gpt-image-2' })).toBe('image_url');
});

test.each([
  ['omitted', { prompt: 'make it night', images: [{ image_url: 'https://example.com/cat.png' }] }],
  ['JSON null', { model: null, prompt: 'make it night', images: [{ image_url: 'https://example.com/cat.png' }] }],
  ['empty string', { model: '', prompt: 'make it night', images: [{ image_url: 'https://example.com/cat.png' }] }],
  ['whitespace', { model: '   ', prompt: 'make it night', images: [{ image_url: 'https://example.com/cat.png' }] }],
] as const)('defaults edits %s model lookup to gpt-image-2', async (_name, body) => {
  const raw = editsRequest(body);
  const request = await openAIImagesAdapter.parse(raw, edits);
  expect(request.model).toBe(CPA_DEFAULT_IMAGE_MODEL);
  expect(request.modelDefaulted).toBe(true);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), edits);
  expect(await forwarded.json()).toMatchObject({ model: 'gpt-image-2', prompt: 'make it night' });
});

test('edits JSON bodyLimits accept the official-max envelope', () => {
  expect(openAIImagesAdapter.bodyLimits(editsRequest(editsImageUrl), edits)).toEqual({
    encoded: 357_564_416,
    decoded: 357_564_416,
  });
  expect(openAIImagesAdapter.bodyLimits(generationsRequest({ prompt: 'a cat' }), generations)).toEqual(
    REQUEST_BODY_LIMITS,
  );
});

test('rewrites a defaulted edits request to the resolved alias target', async () => {
  const raw = editsRequest(editsImageUrl);
  const request = await openAIImagesAdapter.parse(raw, edits);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'acme-image-2', new Set(), edits);
  expect(await forwarded.json()).toMatchObject({ model: 'acme-image-2' });
});

test('forwards explicit same-id edits raw bytes without a JSON round-trip', async () => {
  const bodyText =
    '{"model":"gpt-image-2","seed":9007199254740993,"prompt":"make it night","images":[{"image_url":"https://example.com/cat.png"}]}';
  const raw = new Request('https://x/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  });
  const request = await openAIImagesAdapter.parse(raw, edits);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), edits);
  expect(await forwarded.text()).toBe(bodyText);
});

const PNG_1X1_RGBA = Uint8Array.from(
  Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  ),
);

function editsMultipartRequest(fields: Record<string, string | Blob | readonly Blob[]>): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      form.append(name, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) form.append(name, item);
      continue;
    }
    form.append(name, value);
  }
  return new Request('https://x/v1/images/edits', { method: 'POST', body: form });
}

function pngBlob(): Blob {
  return new Blob([PNG_1X1_RGBA], { type: 'application/octet-stream' });
}

test('mixed-case multipart Content-Type uses edits multipart limits and parses', async () => {
  const raw = editsMultipartRequest({ prompt: 'make it night', image: pngBlob() });
  const contentType = (raw.headers.get('content-type') ?? '').replace('multipart/form-data', 'Multipart/Form-Data');
  const mixed = new Request(raw.url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: raw.body,
  });
  expect(openAIImagesAdapter.bodyLimits(mixed, edits)).toEqual({
    encoded: 851_048_559,
    decoded: 851_048_559,
  });
  const request = await openAIImagesAdapter.parse(mixed, edits);
  expect(request.prompt).toBe('make it night');
});

test('multipart raw rewrite inherits the inbound abort signal', async () => {
  const controller = new AbortController();
  const form = new FormData();
  form.append('prompt', 'make it night');
  form.append('image', pngBlob());
  const raw = new Request('https://x/v1/images/edits', { method: 'POST', body: form, signal: controller.signal });
  const request = await openAIImagesAdapter.parse(raw, edits);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), edits);
  expect(forwarded.signal.aborted).toBe(false);
  controller.abort();
  expect(forwarded.signal.aborted).toBe(true);
});

test('edits multipart bodyLimits accept the official-max envelope and not the language gate', () => {
  const raw = new Request('https://x/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '851048559' },
    body: '--x--',
  });
  expect(openAIImagesAdapter.bodyLimits(raw, edits)).toEqual({
    encoded: 851_048_559,
    decoded: 851_048_559,
  });
  expect(openAIImagesAdapter.bodyLimits(editsRequest(editsImageUrl), edits)).toEqual({
    encoded: 357_564_416,
    decoded: 357_564_416,
  });
});

test.each([
  ['missing', {}],
  ['empty', { model: '' }],
  ['whitespace', { model: '   ' }],
] as const)('defaults edits multipart %s model lookup to gpt-image-2', async (_name, extra) => {
  const raw = editsMultipartRequest({ ...extra, prompt: 'make it night', image: pngBlob() });
  const request = await openAIImagesAdapter.parse(raw, edits);
  expect(request.model).toBe(CPA_DEFAULT_IMAGE_MODEL);
  expect(request.modelDefaulted).toBe(true);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'gpt-image-2', new Set(), edits);
  expect(forwarded.headers.get('content-type') ?? '').toStartWith('multipart/form-data');
  const form = await forwarded.formData();
  expect(form.get('model')).toBe('gpt-image-2');
  expect(form.get('prompt')).toBe('make it night');
});

test('multipart literal null with no alias stays null on raw and convert lookup', async () => {
  const raw = editsMultipartRequest({ model: 'null', prompt: 'make it night', image: pngBlob() });
  const request = await openAIImagesAdapter.parse(raw, edits);
  expect(request.model).toBe('null');
  expect(request.modelDefaulted).toBe(false);
  expect(openAIImagesAdapter.model(request, edits)).toBe('null');
  const original = JSON.parse;
  let parsedJson = false;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parsedJson = true;
    return original(...args);
  }) as typeof JSON.parse;
  try {
    const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'null', new Set(), edits);
    expect(parsedJson).toBe(false);
    expect(forwarded.headers.get('content-type') ?? '').toStartWith('multipart/form-data');
    const form = await forwarded.formData();
    expect(form.get('model')).toBe('null');
  } finally {
    JSON.parse = original;
  }
});

test('multipart rewrite preserves filenames, image[] names, and extra fields', async () => {
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', 'make it night');
  form.append('image[]', new File([PNG_1X1_RGBA], 'cat.png', { type: 'image/png' }));
  form.append('seed', '42');
  const raw = new Request('https://x/v1/images/edits', { method: 'POST', body: form });
  const request = await openAIImagesAdapter.parse(raw, edits);
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'acme-image-2', new Set(), edits);
  const rewritten = await forwarded.formData();
  expect(rewritten.get('model')).toBe('acme-image-2');
  expect(rewritten.get('prompt')).toBe('make it night');
  expect(rewritten.get('seed')).toBe('42');
  expect(rewritten.get('image[]')).toBeInstanceOf(File);
  expect((rewritten.get('image[]') as File).name).toBe('cat.png');
  expect((rewritten.get('image[]') as File).type).toBe('image/png');
  expect(rewritten.get('image')).toBeNull();
});

test('multipart literal null with alias rewrites raw to the resolved target', async () => {
  const raw = editsMultipartRequest({ model: 'null', prompt: 'make it night', image: pngBlob() });
  const request = await openAIImagesAdapter.parse(raw, edits);
  expect(request.model).toBe('null');
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'acme-null', new Set(), edits);
  const form = await forwarded.formData();
  expect(form.get('model')).toBe('acme-null');
});

test('rewrites a defaulted multipart edits request to the resolved alias target', async () => {
  const raw = editsMultipartRequest({ prompt: 'make it night', image: pngBlob() });
  const request = await openAIImagesAdapter.parse(raw, edits);
  expect(request.model).toBe('gpt-image-2');
  const forwarded = await openAIImagesAdapter.rawRequest(raw, request, 'acme-image-2', new Set(), edits);
  const form = await forwarded.formData();
  expect(form.get('model')).toBe('acme-image-2');
  expect(form.get('prompt')).toBe('make it night');
});

test('imageInvocation 400s an undecodable multipart image', async () => {
  const raw = editsMultipartRequest({
    prompt: 'make it night',
    image: new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'image/png' }),
  });
  const request = await openAIImagesAdapter.parse(raw, edits);
  expect(() => openAIImagesAdapter.imageInvocation(request, edits)).toThrow(/image/u);
});

test('imageInvocation attaches decoded multipart bytes and a valid mask', async () => {
  const raw = editsMultipartRequest({
    prompt: 'make it night',
    image: pngBlob(),
    mask: pngBlob(),
  });
  const request = await openAIImagesAdapter.parse(raw, edits);
  const invocation = openAIImagesAdapter.imageInvocation(request, edits);
  expect(invocation.operation).toBe('edit');
  expect(invocation.prompt).toBe('make it night');
  expect(invocation.images).toHaveLength(1);
  expect(invocation.images?.[0]).toMatchObject({
    type: 'bytes',
    format: 'png',
    width: 1,
    height: 1,
    hasAlpha: true,
  });
  expect(invocation.mask).toMatchObject({ format: 'png', width: 1, height: 1, hasAlpha: true });
  expect(invocation.images?.[0]?.data).toEqual(PNG_1X1_RGBA);
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
