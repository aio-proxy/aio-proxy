import { expect, test } from 'bun:test';

import { z } from 'zod';

import { EmbeddingConvertUnsupportedError, ImageInputUnsupportedError } from '../error';
import type { ProtocolErrorMapper } from './adapter';
import {
  anthropicMessagesErrors,
  geminiEmbeddingsErrors,
  geminiGenerateContentErrors,
  openAICompletionsErrors,
  openAIEmbeddingsErrors,
  openAIImagesErrors,
  openAIResponsesErrors,
} from './errors';
import { InvalidCompressedRequestBodyError, RequestBodyIdleTimeoutError } from './request';

const cases = [
  [
    'OpenAI Chat Completions',
    openAICompletionsErrors,
    {
      error: {
        code: 'unsupported_content_encoding',
        message: 'Unsupported Content-Encoding',
        type: 'invalid_request_error',
      },
    },
    {
      error: { code: 'invalid_request', message: 'Invalid OpenAI Completions request', type: 'invalid_request_error' },
    },
  ],
  [
    'OpenAI Images',
    openAIImagesErrors,
    {
      error: {
        code: 'unsupported_content_encoding',
        message: 'Unsupported Content-Encoding',
        type: 'invalid_request_error',
      },
    },
    {
      error: { code: 'invalid_request', message: 'Invalid OpenAI Images request', type: 'invalid_request_error' },
    },
  ],
  [
    'OpenAI Responses',
    openAIResponsesErrors,
    {
      error: {
        code: 'unsupported_content_encoding',
        message: 'Unsupported Content-Encoding',
        type: 'invalid_request_error',
      },
    },
    { error: { code: 'invalid_request', message: 'Invalid OpenAI Responses request', type: 'invalid_request_error' } },
  ],
  [
    'Anthropic Messages',
    anthropicMessagesErrors,
    { type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported Content-Encoding' } },
    { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid Anthropic Messages request' } },
  ],
  [
    'Gemini generateContent',
    geminiGenerateContentErrors,
    { error: { code: 415, message: 'Unsupported Content-Encoding', status: 'INVALID_ARGUMENT' } },
    { error: { code: 400, message: 'Invalid Gemini request', status: 'INVALID_ARGUMENT' } },
  ],
  [
    'OpenAI Embeddings',
    openAIEmbeddingsErrors,
    {
      error: {
        code: 'unsupported_content_encoding',
        message: 'Unsupported Content-Encoding',
        type: 'invalid_request_error',
      },
    },
    {
      error: { code: 'invalid_request', message: 'Invalid OpenAI Embeddings request', type: 'invalid_request_error' },
    },
  ],
  [
    'Gemini embeddings',
    geminiEmbeddingsErrors,
    { error: { code: 415, message: 'Unsupported Content-Encoding', status: 'INVALID_ARGUMENT' } },
    { error: { code: 400, message: 'Invalid Gemini Embeddings request', status: 'INVALID_ARGUMENT' } },
  ],
] as const satisfies readonly (readonly [string, ProtocolErrorMapper, unknown, unknown])[];

test.each(cases)(
  'requestError surfaces ZodError path detail without the received value for %s',
  async (_name, mapper) => {
    const error = z
      .object({ messages: z.array(z.object({ role: z.literal('user') })) })
      .safeParse({ messages: [{ role: 'leaked-secret-value' }] }).error;
    const message = JSON.stringify(await mapper.requestError(error)?.json());

    expect(message).toContain('messages[0].role');
    expect(message).not.toContain('leaked-secret-value');
  },
);

test.each(cases)('maps unsupported content encoding for %s', async (_name, mapper, expected) => {
  const response = mapper.unsupportedContentEncoding();

  expect(response.status).toBe(415);
  expect(await response.json()).toEqual(expected);
  expect(JSON.stringify(expected)).not.toContain('secret-marker');
});

test.each(cases)('maps invalid compressed bodies for %s', async (_name, mapper, _unsupported, expected) => {
  const response = mapper.requestError(new InvalidCompressedRequestBodyError('native decoder detail'));

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual(expected);
  expect(JSON.stringify(expected)).not.toContain('native decoder detail');
});

test.each([
  [
    'OpenAI Chat Completions',
    openAICompletionsErrors,
    {
      error: {
        code: 'previous_response_conflict',
        message: 'previous_response_id matches multiple providers',
        type: 'invalid_request_error',
      },
    },
  ],
  [
    'OpenAI Images',
    openAIImagesErrors,
    {
      error: {
        code: 'previous_response_conflict',
        message: 'previous_response_id matches multiple providers',
        type: 'invalid_request_error',
      },
    },
  ],
  [
    'OpenAI Responses',
    openAIResponsesErrors,
    {
      error: {
        code: 'previous_response_conflict',
        message: 'previous_response_id matches multiple providers',
        type: 'invalid_request_error',
      },
    },
  ],
  [
    'Anthropic Messages',
    anthropicMessagesErrors,
    {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'previous_response_id matches multiple providers' },
    },
  ],
  [
    'Gemini generateContent',
    geminiGenerateContentErrors,
    {
      error: { code: 409, message: 'previous_response_id matches multiple providers', status: 'ABORTED' },
    },
  ],
  [
    'OpenAI Embeddings',
    openAIEmbeddingsErrors,
    {
      error: {
        code: 'previous_response_conflict',
        message: 'previous_response_id matches multiple providers',
        type: 'invalid_request_error',
      },
    },
  ],
  [
    'Gemini embeddings',
    geminiEmbeddingsErrors,
    {
      error: { code: 409, message: 'previous_response_id matches multiple providers', status: 'ABORTED' },
    },
  ],
] as const)('maps ambiguous previous responses for %s', async (_name, mapper, expected) => {
  const conflict = (mapper as ProtocolErrorMapper & { previousResponseConflict?: () => Response })
    .previousResponseConflict;

  expect(conflict).toBeFunction();
  if (conflict === undefined) return;
  const response = conflict();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(expected);
});

test('maps image compatibility errors into every inbound protocol shape', async () => {
  const error = new ImageInputUnsupportedError('gemini-tool-url', 'messages.2.content.0.output.value.1');
  const cases = [
    [openAICompletionsErrors, 501, 'unsupported_feature'],
    [openAIResponsesErrors, 501, 'unsupported_feature'],
    [openAIEmbeddingsErrors, 501, 'unsupported_feature'],
    [anthropicMessagesErrors, 501, 'invalid_request_error'],
    [geminiGenerateContentErrors, 501, 'UNIMPLEMENTED'],
    [geminiEmbeddingsErrors, 501, 'UNIMPLEMENTED'],
  ] as const;

  for (const [mapper, status, marker] of cases) {
    const response = mapper.modelUnsupported?.(error);
    expect(response?.status).toBe(status);
    const body = await response?.text();
    expect(body).toContain(marker);
    expect(body).not.toContain('https://');
    expect(body).not.toContain('file_');
  }
});

test('openai completions rateLimited builds a native 429 with Retry-After', async () => {
  const r = openAICompletionsErrors.rateLimited(3);
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('3');
  expect(await r.json()).toEqual({
    error: { code: 'rate_limit_exceeded', message: expect.any(String), type: 'rate_limit_error' },
  });
});

test('openai images maps stalled multipart reads to 408 and abort to 499', async () => {
  const timeout = openAIImagesErrors.requestError(new RequestBodyIdleTimeoutError());
  expect(timeout?.status).toBe(408);
  expect(await timeout?.json()).toMatchObject({ error: { code: 'request_timeout' } });
  const aborted = openAIImagesErrors.requestError(new DOMException('The operation was aborted.', 'AbortError'));
  expect(aborted?.status).toBe(499);
  expect(await aborted?.json()).toMatchObject({ error: { code: 'aborted' } });
});

test('openai images rateLimited builds a native 429 with Retry-After', async () => {
  const r = openAIImagesErrors.rateLimited(3);
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('3');
  expect(await r.json()).toEqual({
    error: { code: 'rate_limit_exceeded', message: expect.any(String), type: 'rate_limit_error' },
  });
});

test('openai responses rateLimited builds a native 429 with Retry-After', async () => {
  const r = openAIResponsesErrors.rateLimited(3);
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('3');
  expect(await r.json()).toEqual({
    error: { code: 'rate_limit_exceeded', message: expect.any(String), type: 'rate_limit_error' },
  });
});

test('anthropic rateLimited builds a native 429 with Retry-After', async () => {
  const r = anthropicMessagesErrors.rateLimited(3);
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('3');
  expect(await r.json()).toEqual({
    type: 'error',
    error: { type: 'rate_limit_error', message: expect.any(String) },
  });
});

test('gemini rateLimited builds a native 429 with Retry-After', async () => {
  const r = geminiGenerateContentErrors.rateLimited(3);
  expect(r.status).toBe(429);
  expect(r.headers.get('retry-after')).toBe('3');
  expect(await r.json()).toEqual({
    error: { code: 429, message: expect.any(String), status: 'RESOURCE_EXHAUSTED' },
  });
});

test('maps EmbeddingConvertUnsupportedError to 501 so parse stays 400-only', async () => {
  const response = openAIEmbeddingsErrors.requestError(new EmbeddingConvertUnsupportedError('token-id'));

  expect(response?.status).toBe(501);
  expect(await response?.json()).toEqual({
    error: {
      code: 'not_implemented',
      message: 'Embedding convert does not support token-id',
      type: 'unsupported_feature',
    },
  });
});

test('maps a transport-side EmbeddingConvertUnsupportedError to 501 for OpenAI embeddings', async () => {
  const response = openAIEmbeddingsErrors.provider(new EmbeddingConvertUnsupportedError('title'));

  expect(response?.status).toBe(501);
  expect(await response?.json()).toEqual({
    error: {
      code: 'not_implemented',
      message: 'Embedding convert does not support title',
      type: 'unsupported_feature',
    },
  });
});

test('maps a transport-side EmbeddingConvertUnsupportedError to 501 for Gemini embeddings', async () => {
  const error = new EmbeddingConvertUnsupportedError('autoTruncate');
  const request = geminiEmbeddingsErrors.requestError(error);
  const provider = geminiEmbeddingsErrors.provider(error);

  expect(request?.status).toBe(501);
  expect(provider?.status).toBe(501);
  expect(await provider?.json()).toEqual({
    error: { code: 501, message: 'Embedding convert does not support autoTruncate', status: 'UNIMPLEMENTED' },
  });
});

test('embeddings unsupported names transform dispatch', async () => {
  const response = openAIEmbeddingsErrors.unsupported('token-id');

  expect(response.status).toBe(501);
  expect(await response.json()).toEqual({
    error: {
      code: 'not_implemented',
      message: 'Provider does not support OpenAI Embeddings transform dispatch',
      type: 'invalid_request_error',
    },
  });
});

test('gemini embeddings unsupported names transform dispatch', async () => {
  const response = geminiEmbeddingsErrors.unsupported('title');

  expect(response.status).toBe(501);
  expect(await response.json()).toEqual({
    error: {
      code: 501,
      message: 'Provider does not support Gemini embeddings transform dispatch',
      status: 'UNIMPLEMENTED',
    },
  });
});
