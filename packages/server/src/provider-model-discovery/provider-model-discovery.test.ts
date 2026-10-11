import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { npmPackageCacheDir } from '@aio-proxy/core';
import { AiSdkProviderSchema, ApiProviderSchema, ConfigSchema, ProviderProtocol } from '@aio-proxy/types';

import { discoverProviderModels } from './index';

const config = ConfigSchema.parse({ providers: {} });
const unavailable = { ok: false, code: 'catalog_unavailable' };
const apiProvider = (baseURL: string, protocol = ProviderProtocol.OpenAICompatible, enabled = true) =>
  ApiProviderSchema.parse({ id: 'catalog', kind: 'api', baseURL, protocol, enabled });

describe('shared Provider model discovery', () => {
  test('pages an Anthropic catalog through has_more', async () => {
    const paths: string[] = [];
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        paths.push(`${url.pathname}${url.search}`);
        return Response.json(
          url.searchParams.has('after_id')
            ? { data: [{ id: 'b' }, { id: 'a' }], has_more: false }
            : { data: [{ id: 'a' }], has_more: true, last_id: 'a' },
        );
      },
    });

    try {
      const result = await discoverProviderModels(
        config,
        apiProvider(upstream.url.origin, ProviderProtocol.Anthropic),
        AbortSignal.timeout(5_000),
        { strict: true },
      );
      expect(result).toEqual({ ok: true, models: ['a', 'b'] });
      expect(paths).toEqual(['/v1/models', '/v1/models?after_id=a']);
    } finally {
      await upstream.stop(true);
    }
  });

  test('returns catalog_unavailable on a 503', async () => {
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 503 }) });
    try {
      expect(
        await discoverProviderModels(config, apiProvider(upstream.url.origin), AbortSignal.timeout(5_000), {
          strict: true,
        }),
      ).toEqual(unavailable);
    } finally {
      await upstream.stop(true);
    }
  });

  test('strict discovery rejects a page with one malformed row', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'a' }, { id: 42 }] }),
    });
    try {
      const provider = apiProvider(upstream.url.origin);
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: true })).toEqual(
        unavailable,
      );
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: false })).toEqual({
        ok: true,
        models: ['a'],
      });
    } finally {
      await upstream.stop(true);
    }
  });

  test('discovers a disabled Provider', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'a' }] }),
    });
    try {
      const provider = apiProvider(upstream.url.origin, ProviderProtocol.OpenAICompatible, false);
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: true })).toEqual({
        ok: true,
        models: ['a'],
      });
      expect(provider.enabled).toBe(false);
    } finally {
      await upstream.stop(true);
    }
  });

  test.each([null, {}, { id: '' }, { id: '   ' }])('strict discovery rejects missing or blank IDs: %j', async (row) => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'a' }, row] }),
    });
    try {
      const provider = apiProvider(upstream.url.origin);
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: true })).toEqual(
        unavailable,
      );
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: false })).toEqual({
        ok: true,
        models: ['a'],
      });
    } finally {
      await upstream.stop(true);
    }
  });

  test.each([
    [ProviderProtocol.Gemini, { nextPageToken: 42 }],
    [ProviderProtocol.GeminiInteractions, { nextPageToken: 42 }],
    [ProviderProtocol.Anthropic, { has_more: 'yes' }],
  ])('strict discovery rejects malformed pagination for %s: %j', async (protocol, pagination) => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'a' }], models: [{ name: 'models/a' }], ...pagination }),
    });
    try {
      const provider = apiProvider(upstream.url.origin, protocol);
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: true })).toEqual(
        unavailable,
      );
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: false })).toEqual({
        ok: true,
        models: ['a'],
      });
    } finally {
      await upstream.stop(true);
    }
  });

  test.each([
    [ProviderProtocol.OpenAICompatible, { has_more: false, last_id: null, first_id: null }],
    [ProviderProtocol.Anthropic, { has_more: false, last_id: null }],
    [ProviderProtocol.Anthropic, { has_more: null, last_id: null }],
    [ProviderProtocol.Gemini, { nextPageToken: null }],
    [ProviderProtocol.GeminiInteractions, { nextPageToken: null }],
  ])('strict discovery accepts null pagination fields', async (protocol, pagination) => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'a' }], models: [{ name: 'models/a' }], ...pagination }),
    });
    try {
      const provider = apiProvider(upstream.url.origin, protocol);
      for (const strict of [true, false]) {
        expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict })).toEqual({
          ok: true,
          models: ['a'],
        });
      }
    } finally {
      await upstream.stop(true);
    }
  });

  test.each([
    [ProviderProtocol.OpenAICompatible, { has_more: 'yes', last_id: 42, nextPageToken: 42 }],
    [ProviderProtocol.OpenAIResponse, { has_more: 'yes', last_id: 42, nextPageToken: 42 }],
    [ProviderProtocol.Gemini, { has_more: 'yes', last_id: 42 }],
    [ProviderProtocol.GeminiInteractions, { has_more: 'yes', last_id: 42 }],
    [ProviderProtocol.Anthropic, { has_more: false, last_id: 42, nextPageToken: 42 }],
  ])('strict discovery ignores unused pagination fields for %s', async (protocol, pagination) => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'a' }], models: [{ name: 'models/a' }], ...pagination }),
    });
    try {
      const provider = apiProvider(upstream.url.origin, protocol);
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: true })).toEqual({
        ok: true,
        models: ['a'],
      });
    } finally {
      await upstream.stop(true);
    }
  });

  test.each([null, undefined, 42])('strict discovery rejects a malformed Anthropic cursor', async (lastId) => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'a' }], has_more: true, last_id: lastId }),
    });
    try {
      const provider = apiProvider(upstream.url.origin, ProviderProtocol.Anthropic);
      for (const strict of [true, false]) {
        expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict })).toEqual(
          unavailable,
        );
      }
    } finally {
      await upstream.stop(true);
    }
  });

  test.each([
    { rows: ['a', { id: 'b' }, 'a'], strict: { ok: true, models: ['a', 'b'] }, lenient: ['a', 'b'] },
    { rows: { id: 'a' }, strict: unavailable, lenient: ['fallback'] },
    { rows: ['a', { id: 42 }], strict: unavailable, lenient: ['a'] },
    { rows: ['a', '   '], strict: unavailable, lenient: ['a'] },
  ])('validates custom AI SDK listModels results: $rows', async ({ rows, strict, lenient }) => {
    const packageName = `@example/shared-discovery-${crypto.randomUUID()}`;
    const cacheDirectory = npmPackageCacheDir(packageName);
    const packageDirectory = join(cacheDirectory, 'node_modules', packageName);
    await Bun.write(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', exports: './index.js' }),
    );
    await Bun.write(
      join(packageDirectory, 'index.js'),
      `export const createCatalogProvider = (options) => ({
        listModels: async (signal) => (await options.fetch(options.baseURL + '/catalog', { signal })).json(),
      });\n`,
    );
    const paths: string[] = [];
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return Response.json(path === '/catalog' ? rows : { data: [{ id: 'fallback' }] });
      },
    });
    try {
      const provider = AiSdkProviderSchema.parse({
        id: 'custom-sdk',
        kind: 'ai-sdk',
        packageName,
        options: { baseURL: upstream.url.origin },
      });
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: true })).toEqual(
        strict,
      );
      expect(paths).toEqual(['/catalog']);
      expect(await discoverProviderModels(config, provider, AbortSignal.timeout(5_000), { strict: false })).toEqual({
        ok: true,
        models: lenient,
      });
    } finally {
      await upstream.stop(true);
      rmSync(cacheDirectory, { force: true, recursive: true });
    }
  });
});
