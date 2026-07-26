import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { assertImageInputSupported, imageFilePart, imageTargetProtocolForPackage } from '.';
import type { ModelMessage } from '../ai-sdk-bridge';
import { ImageInputUnsupportedError } from '../error';

describe('image compatibility preflight', () => {
  test('rejects a Gemini URL image when no MIME subtype can be inferred', () => {
    const image = imageFilePart({ type: 'url', url: 'https://example.test/media?id=123' });
    if (image === undefined) throw new Error('image fixture was rejected');
    const messages = [{ role: 'user' as const, content: [image] }] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(messages, ProviderProtocol.Gemini)).toThrow(ImageInputUnsupportedError);
    expect(() => assertImageInputSupported(messages, ProviderProtocol.Anthropic)).not.toThrow();
  });

  test('allows image detail only on an OpenAI Responses target', () => {
    const image = imageFilePart({ type: 'base64', mediaType: 'image/png', data: 'AA==' }, { detail: 'low' });
    if (image === undefined) throw new Error('image fixture was rejected');
    const messages = [{ role: 'user' as const, content: [image] }] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(messages, ProviderProtocol.OpenAIResponse)).not.toThrow();
    for (const target of [
      undefined,
      ProviderProtocol.OpenAICompatible,
      ProviderProtocol.Anthropic,
      ProviderProtocol.Gemini,
    ]) {
      expect(() => assertImageInputSupported(messages, target)).toThrow(
        new ImageInputUnsupportedError('image-detail', 'messages.0.content.0'),
      );
    }
  });

  test('rejects assistant images outside Gemini targets', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'file' as const,
            mediaType: 'image/png',
            data: { type: 'data' as const, data: 'AA==' },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(messages, ProviderProtocol.Gemini)).not.toThrow();
    for (const target of [
      undefined,
      ProviderProtocol.OpenAIResponse,
      ProviderProtocol.OpenAICompatible,
      ProviderProtocol.Anthropic,
    ]) {
      expect(() => assertImageInputSupported(messages, target)).toThrow(
        new ImageInputUnsupportedError('assistant-image', 'messages.0.content.0'),
      );
    }
  });

  test('allows Gemini assistant data and references but rejects URLs', () => {
    const googleReference = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'file' as const,
            mediaType: 'image/png',
            data: {
              type: 'reference' as const,
              reference: { google: 'https://example.test/prior.png' },
            },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];
    const remoteImage = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'file' as const,
            mediaType: 'image/png',
            data: { type: 'url' as const, url: new URL('https://example.test/prior.png') },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(googleReference, ProviderProtocol.Gemini)).not.toThrow();
    expect(() => assertImageInputSupported(googleReference, ProviderProtocol.Anthropic)).toThrow(
      new ImageInputUnsupportedError('assistant-image', 'messages.0.content.0'),
    );
    expect(() => assertImageInputSupported(remoteImage, ProviderProtocol.Gemini)).toThrow(
      new ImageInputUnsupportedError('gemini-assistant-url', 'messages.0.content.0'),
    );
  });

  test('allows an OpenAI user reference only on the OpenAI Responses target', () => {
    const reference = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'file' as const,
            mediaType: 'image',
            data: { type: 'reference' as const, reference: { openai: 'file_123' } },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(reference, ProviderProtocol.OpenAIResponse)).not.toThrow();
    expect(() => assertImageInputSupported(reference, ProviderProtocol.Anthropic)).toThrow(
      new ImageInputUnsupportedError('provider-reference', 'messages.0.content.0'),
    );
  });

  test('maps only the four known AI SDK packages', () => {
    expect(imageTargetProtocolForPackage('@ai-sdk/openai')).toBe(ProviderProtocol.OpenAIResponse);
    expect(imageTargetProtocolForPackage('@ai-sdk/openai-compatible')).toBe(ProviderProtocol.OpenAICompatible);
    expect(imageTargetProtocolForPackage('@ai-sdk/anthropic')).toBe(ProviderProtocol.Anthropic);
    expect(imageTargetProtocolForPackage('@ai-sdk/google')).toBe(ProviderProtocol.Gemini);
    expect(imageTargetProtocolForPackage('@vendor/unknown')).toBeUndefined();
  });
});
