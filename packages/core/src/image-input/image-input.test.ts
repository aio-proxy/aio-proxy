import { describe, expect, test } from 'bun:test';

import { imageFilePart, isHttpUrl, isImageMediaType, isValidBase64 } from '.';

describe('imageFilePart', () => {
  test('normalizes data URLs, remote URLs, details, references, and tool markers', () => {
    expect(
      imageFilePart({ type: 'url', url: 'data:image/png;base64,AA==' }, { detail: 'low', toolResult: true }),
    ).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data', data: 'AA==' },
      providerOptions: {
        openai: { imageDetail: 'low' },
        aioProxy: { toolImage: true, trust: expect.any(String) },
      },
    });
    expect(imageFilePart({ type: 'url', url: 'https://example.test/image.png' })).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'url', url: new URL('https://example.test/image.png') },
    });
    expect(imageFilePart({ type: 'reference', provider: 'openai', id: 'file_123' })).toEqual({
      type: 'file',
      mediaType: 'image',
      data: { type: 'reference', reference: { openai: 'file_123' } },
    });
  });

  test('rejects malformed bytes, MIME types, data URLs, and non-HTTP URLs', () => {
    expect(isValidBase64('AA==')).toBe(true);
    expect(isValidBase64('not base64')).toBe(false);
    expect(isImageMediaType('image/webp')).toBe(true);
    expect(isImageMediaType('application/pdf')).toBe(false);
    expect(isHttpUrl('https://example.test/image.png')).toBe(true);
    expect(isHttpUrl('http:///')).toBe(false);
    expect(isHttpUrl('file:///tmp/image.png')).toBe(false);
    expect(imageFilePart({ type: 'base64', mediaType: 'image/png', data: '!' })).toBeUndefined();
    expect(imageFilePart({ type: 'base64', mediaType: 'image', data: 'AA==' })).toBeUndefined();
    expect(imageFilePart({ type: 'url', url: 'data:image/png;base64,!' })).toBeUndefined();
    expect(imageFilePart({ type: 'url', url: 'ftp://example.test/image.png' })).toBeUndefined();
  });
});
