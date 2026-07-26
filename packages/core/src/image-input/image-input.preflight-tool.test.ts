import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { assertImageInputSupported } from '.';
import type { ModelMessage } from '../ai-sdk-bridge';
import { ImageInputUnsupportedError } from '../error';

describe('image compatibility preflight', () => {
  const remoteToolImage = [
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'call_1',
          toolName: 'inspect',
          output: {
            type: 'content' as const,
            value: [
              {
                type: 'file' as const,
                mediaType: 'image',
                data: { type: 'url' as const, url: new URL('https://example.test/image.png') },
                providerOptions: { aioProxy: { toolImage: true } },
              },
            ],
          },
        },
      ],
    },
  ] satisfies readonly ModelMessage[];

  test('rejects remote Gemini tool images and unresolved tool targets', () => {
    expect(() => assertImageInputSupported(remoteToolImage, ProviderProtocol.Gemini)).toThrow(
      new ImageInputUnsupportedError('gemini-tool-url', 'messages.0.content.0.output.value.0'),
    );
    expect(() => assertImageInputSupported(remoteToolImage, undefined)).toThrow(
      new ImageInputUnsupportedError('unknown-target', 'messages.0.content.0.output.value.0'),
    );
    expect(() => assertImageInputSupported(remoteToolImage, ProviderProtocol.Anthropic)).not.toThrow();
  });

  test('allows portable inline tool images before the target is resolved', () => {
    const inlineToolImage = [
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call_1',
            toolName: 'inspect',
            output: {
              type: 'content' as const,
              value: [
                {
                  type: 'file' as const,
                  mediaType: 'image/png',
                  data: { type: 'data' as const, data: 'AA==' },
                },
              ],
            },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(inlineToolImage, undefined)).not.toThrow();
  });

  test('allows an ordinary remote user image before the target is resolved', () => {
    const remoteUserImage = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'file' as const,
            mediaType: 'image/png',
            data: { type: 'url' as const, url: new URL('https://example.test/image.png') },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(remoteUserImage, undefined)).not.toThrow();
  });
});
