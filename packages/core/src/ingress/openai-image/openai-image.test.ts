import { expect, test } from 'bun:test';

import { ZodError } from 'zod';

import { CPA_DEFAULT_IMAGE_MODEL, parseOpenAIImageGenerations } from './openai-image';

test('parses a valid generations body and keeps the explicit model', () => {
  expect(parseOpenAIImageGenerations({ model: 'gpt-image-1', prompt: 'a cat', n: 2 })).toEqual({
    model: 'gpt-image-1',
    modelDefaulted: false,
    clientModel: 'gpt-image-1',
    prompt: 'a cat',
    n: 2,
  });
});

test('rejects a missing prompt', () => {
  expect(() => parseOpenAIImageGenerations({ model: 'gpt-image-2' })).toThrow(ZodError);
});

test.each([
  ['omitted', {}],
  ['JSON null', { model: null }],
  ['empty string', { model: '' }],
  ['whitespace', { model: '  \t' }],
] as const)('defaults %s model to gpt-image-2', (_name, extra) => {
  const parsed = parseOpenAIImageGenerations({ ...extra, prompt: 'a cat' });
  expect(parsed.model).toBe(CPA_DEFAULT_IMAGE_MODEL);
  expect(CPA_DEFAULT_IMAGE_MODEL).toBe('gpt-image-2');
  expect(parsed.modelDefaulted).toBe(true);
  expect(parsed.clientModel).toBeUndefined();
});

test('treats the four-character string null as a real model id', () => {
  const parsed = parseOpenAIImageGenerations({ model: 'null', prompt: 'a cat' });
  expect(parsed.model).toBe('null');
  expect(parsed.modelDefaulted).toBe(false);
  expect(parsed.clientModel).toBe('null');
});

test('GPT-only fields do not change the omitted-model default and do not 400', () => {
  const parsed = parseOpenAIImageGenerations({
    prompt: 'a cat',
    background: 'transparent',
    output_format: 'png',
    output_compression: 80,
    moderation: 'auto',
    stream: false,
    partial_images: 2,
  });
  expect(parsed.model).toBe('gpt-image-2');
  expect(parsed.modelDefaulted).toBe(true);
  expect(parsed.background).toBe('transparent');
  expect(parsed.output_format).toBe('png');
  expect(parsed.output_compression).toBe(80);
  expect(parsed.moderation).toBe('auto');
  expect(parsed.stream).toBe(false);
  expect(parsed.partial_images).toBe(2);
});

test('omitted model plus stream true parses as the CPA default, not a missing-model 400', () => {
  const parsed = parseOpenAIImageGenerations({ prompt: 'a cat', stream: true });
  expect(parsed.model).toBe('gpt-image-2');
  expect(parsed.modelDefaulted).toBe(true);
  expect(parsed.stream).toBe(true);
});

test.each(['dall-e-3', 'acme/dall-e-3'] as const)('rejects explicit %s with n=2', (model) => {
  expect(() => parseOpenAIImageGenerations({ model, prompt: 'a cat', n: 2 })).toThrow(ZodError);
});

test.each(['dall-e-3', 'acme/dall-e-3'] as const)('allows explicit %s with n=1', (model) => {
  expect(parseOpenAIImageGenerations({ model, prompt: 'a cat', n: 1 }).n).toBe(1);
});

test('other requested models accept convert n 1 through 10', () => {
  expect(parseOpenAIImageGenerations({ model: 'gpt-image-2', prompt: 'a cat', n: 1 }).n).toBe(1);
  expect(parseOpenAIImageGenerations({ model: 'gpt-image-2', prompt: 'a cat', n: 10 }).n).toBe(10);
});

test('rejects convert n outside 1 through 10 on other models', () => {
  expect(() => parseOpenAIImageGenerations({ model: 'gpt-image-2', prompt: 'a cat', n: 11 })).toThrow(ZodError);
  expect(() => parseOpenAIImageGenerations({ model: 'pool', prompt: 'a cat', n: 0 })).toThrow(ZodError);
});

test('stores omitted and JSON-null n as null', () => {
  expect(parseOpenAIImageGenerations({ prompt: 'a cat' }).n).toBeNull();
  expect(parseOpenAIImageGenerations({ prompt: 'a cat', n: null }).n).toBeNull();
});
