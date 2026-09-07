import { describe, expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { MuseCodeCredential } from '../schema';
import { discoverMuseCodeModels, initialMuseCodeCatalogFallback, MuseCodeCatalogError } from './catalog';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'minted-key',
  accountId: 'user-1',
};

describe('Muse Code catalog', () => {
  test('lists Spark language models with the minted key and drops image/voice ids', async () => {
    let request: Request | undefined;
    let traffic: unknown;
    const catalog = await discoverMuseCodeModels(context(), {
      fetch: async (input, init) => {
        traffic = (init as RuntimeRequestInit | undefined)?.aioProxy;
        request = new Request(input, init);
        return Response.json({
          data: [
            { id: 'muse-spark-1.3', name: 'ignored' },
            { id: 'muse-image-1.0' },
            { id: 'muse-voice-transcribe-1.0' },
            { id: '  ' },
            { id: 'other-model' },
          ],
        });
      },
    });
    expect(request?.url).toBe('https://api.meta.ai/v1/models');
    expect(request?.headers.get('authorization')).toBe('Bearer minted-key');
    expect(request?.headers.get('x-api-version')).toBe('1.0.0');
    expect(traffic).toEqual({ traffic: 'control' });
    expect(catalog.language).toEqual([
      { id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3', extra: { protocol: 'openai-response' } },
    ]);
    expect(catalog.image).toEqual([]);
    expect(catalog.embedding).toEqual([]);
    expect(catalog.speech).toEqual([]);
    expect(catalog.transcription).toEqual([]);
  });

  test('falls back only for retryable discovery failures', () => {
    const fallback = initialMuseCodeCatalogFallback(new MuseCodeCatalogError('network', true));
    expect(fallback?.language.map((model) => model.id)).toEqual([
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
    ]);
    expect(fallback?.language.every((model) => model.extra)).toEqual(true);
    expect(initialMuseCodeCatalogFallback(new MuseCodeCatalogError('unauthorized', false, 401))).toBeUndefined();
    expect(initialMuseCodeCatalogFallback(new DOMException('cancelled', 'AbortError'))).toBeUndefined();
  });

  test('treats a successful empty catalog as authoritative', async () => {
    const catalog = await discoverMuseCodeModels(context(), {
      fetch: async () => Response.json({ data: [] }),
    });
    expect(catalog.language).toEqual([]);
  });
});

function context() {
  const port: CredentialPort<MuseCodeCredential> = {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('catalog must not refresh');
    },
  };
  return { credentials: port, options: {}, signal: new AbortController().signal };
}
