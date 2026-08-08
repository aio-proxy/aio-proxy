import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigSchema, ProviderProtocol } from '@aio-proxy/types';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createServerState, type ServerState } from '../../server-state';
import { createDashboardRoutes } from '../config';
import { resolveProviderDraft } from './provider-draft-operations';

const jsonRequest = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
});

describe('draft Provider catalog and test routes', () => {
  let directory: string;
  let state: ServerState;
  let routes: ReturnType<typeof createDashboardRoutes>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-provider-draft-'));
    state = await createServerState({
      config: ConfigSchema.parse({
        providers: {
          saved: {
            apiKey: 'saved-secret',
            baseURL: 'http://saved.example/v1',
            headers: { 'content-type': 'application/json', 'x-saved-secret': 'saved-header' },
            kind: 'api',
            models: ['saved-model'],
            protocol: ProviderProtocol.OpenAICompatible,
          },
          'saved-proxied': {
            baseURL: 'https://saved.example/v1',
            kind: 'api',
            models: ['saved-model'],
            protocol: ProviderProtocol.OpenAICompatible,
            proxy: 'https://saved-proxy.example:8443',
          },
          'saved-sdk': {
            kind: 'ai-sdk',
            models: ['saved-sdk-model'],
            options: {
              apiKey: 'saved-sdk-secret',
              baseURL: 'http://saved-sdk.example/v1',
              headers: { 'x-saved-sdk-secret': 'saved-sdk-header' },
              name: 'saved-sdk',
            },
            packageName: '@ai-sdk/openai-compatible',
          },
        },
      }),
      dbHome: directory,
    });
    routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  });

  afterEach(() => {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  });

  test('imports an API draft catalog without persisting the Provider or returning its secret', async () => {
    let authorization: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        return Response.json({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest({
          draft: {
            apiKey: 'draft-secret',
            baseURL: `http://127.0.0.1:${upstream.port}/v1`,
            id: 'unsaved',
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
          },
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ ok: true, models: ['model-b', 'model-a'] });
      expect(authorization).toBe('Bearer draft-secret');
      expect(text).not.toContain('draft-secret');
      expect(state.currentConfig().providers.map(({ id }) => id)).toEqual(['saved', 'saved-proxied', 'saved-sdk']);
    } finally {
      await upstream.stop(true);
    }
  });

  test('imports Gemini model names from the protocol catalog endpoint', async () => {
    let pathname = '';
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        pathname = new URL(request.url).pathname;
        return Response.json({ models: [{ name: 'models/gemini-2.5-flash' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest({
          draft: {
            baseURL: `http://127.0.0.1:${upstream.port}`,
            id: 'gemini-draft',
            kind: 'api',
            protocol: ProviderProtocol.Gemini,
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, models: ['gemini-2.5-flash'] });
      expect(pathname).toBe('/v1beta/models');
    } finally {
      await upstream.stop(true);
    }
  });

  test('returns a recoverable catalog failure without reflecting the upstream body', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('upstream-secret-body', { status: 502 }),
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest({
          draft: {
            baseURL: `http://127.0.0.1:${upstream.port}`,
            id: 'unavailable',
            kind: 'api',
            protocol: ProviderProtocol.Anthropic,
          },
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: { code: 'catalog_unavailable', recoverable: true },
      });
      expect(text).not.toContain('upstream-secret-body');
    } finally {
      await upstream.stop(true);
    }
  });

  test('returns a recoverable unsupported catalog result for an AI SDK draft', async () => {
    const response = await routes.request(
      '/providers/draft/catalog',
      jsonRequest({
        draft: {
          id: 'sdk-draft',
          kind: 'ai-sdk',
          packageName: '@ai-sdk/openai-compatible',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'catalog_unsupported', recoverable: true },
    });
  });

  test('rejects a raw redacted proxy sentinel without leaking or interpreting it as a URL', async () => {
    const response = await routes.request(
      '/providers/draft/catalog',
      jsonRequest({
        draft: {
          baseURL: 'https://api.example/v1',
          id: 'saved',
          kind: 'api',
          protocol: ProviderProtocol.OpenAICompatible,
          proxy: '****',
        },
        persistedProviderId: 'saved',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'redacted_proxy_unsupported', recoverable: true },
    });
  });

  test('restores an unchanged proxy and materializes only explicit changed proxy semantics', () => {
    const baseDraft = {
      baseURL: 'https://saved.example/v1',
      id: 'saved-proxied',
      kind: 'api' as const,
      protocol: ProviderProtocol.OpenAICompatible,
    };

    const preserved = resolveProviderDraft(state, baseDraft, 'saved-proxied');
    const unchanged = resolveProviderDraft(
      state,
      { ...baseDraft, proxy: 'https://saved-proxy.example:8443' },
      'saved-proxied',
    );
    const inherited = resolveProviderDraft(state, { ...baseDraft, proxy: null }, 'saved-proxied');
    const disabled = resolveProviderDraft(state, { ...baseDraft, proxy: false }, 'saved-proxied');
    const replaced = resolveProviderDraft(
      state,
      { ...baseDraft, proxy: 'https://replacement-proxy.example:9443' },
      'saved-proxied',
    );

    expect(preserved.ok && preserved.provider.proxy).toBe('https://saved-proxy.example:8443');
    expect(unchanged.ok && unchanged.provider.proxy).toBe('https://saved-proxy.example:8443');
    expect(inherited.ok && inherited.provider.proxy).toBeUndefined();
    expect(disabled.ok && disabled.provider.proxy).toBe(false);
    expect(replaced.ok && replaced.provider.proxy).toBe('https://replacement-proxy.example:9443');
  });

  test('restores omitted saved credentials in memory for an edit draft with the same identity', () => {
    const resolved = resolveProviderDraft(
      state,
      {
        baseURL: 'http://saved.example/v1',
        id: 'saved',
        kind: 'api',
        protocol: ProviderProtocol.OpenAICompatible,
      },
      'saved',
    );

    expect(resolved).toMatchObject({
      ok: true,
      provider: {
        apiKey: 'saved-secret',
        headers: { 'x-saved-secret': 'saved-header' },
      },
    });
  });

  test('restores redacted AI SDK credentials when null preserves inherited proxy semantics', () => {
    const resolved = resolveProviderDraft(
      state,
      {
        id: 'saved-sdk',
        kind: 'ai-sdk',
        options: {
          apiKey: '****',
          baseURL: 'http://saved-sdk.example/v1',
          headers: { 'x-saved-sdk-secret': '****' },
          name: 'saved-sdk',
        },
        packageName: '@ai-sdk/openai-compatible',
        proxy: null,
      },
      'saved-sdk',
    );

    expect(resolved).toMatchObject({
      ok: true,
      provider: {
        options: {
          apiKey: 'saved-sdk-secret',
          baseURL: 'http://saved-sdk.example/v1',
          headers: { 'x-saved-sdk-secret': 'saved-sdk-header' },
        },
      },
    });
  });

  test('omits embedded redacted AI SDK options from a changed target', () => {
    const resolved = resolveProviderDraft(
      state,
      {
        id: 'saved-sdk',
        kind: 'ai-sdk',
        options: {
          apiKey: 'fresh-sdk-secret',
          baseURL: 'http://changed-sdk.example/v1',
          config: '{"apiKey":"****"}',
          name: 'changed-sdk',
        },
        packageName: '@ai-sdk/openai-compatible',
      },
      'saved-sdk',
    );

    expect(resolved).toEqual({
      ok: true,
      provider: {
        enabled: true,
        id: 'saved-sdk',
        kind: 'ai-sdk',
        options: {
          apiKey: 'fresh-sdk-secret',
          baseURL: 'http://changed-sdk.example/v1',
          name: 'changed-sdk',
        },
        packageName: '@ai-sdk/openai-compatible',
      },
    });
  });

  test('uses only fresh API credentials for a changed destination and proxy', async () => {
    let authorization: string | null = null;
    let freshHeader: string | null = null;
    let savedHeader: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        freshHeader = request.headers.get('x-fresh');
        savedHeader = request.headers.get('x-saved-secret');
        return Response.json({ data: [{ id: 'fresh-model' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest({
          draft: {
            apiKey: 'fresh-secret',
            baseURL: `http://127.0.0.1:${upstream.port}/v1`,
            headers: { 'x-fresh': 'fresh-header', 'x-saved-secret': '****' },
            id: 'saved',
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            proxy: false,
          },
          persistedProviderId: 'saved',
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ ok: true, models: ['fresh-model'] });
      expect(authorization).toBe('Bearer fresh-secret');
      expect(freshHeader).toBe('fresh-header');
      expect(savedHeader).toBeNull();
      expect(text).not.toMatch(/fresh-secret|saved-secret|saved-header/u);
    } finally {
      await upstream.stop(true);
    }
  });

  test('accepts a fresh authorization header for a changed API destination', async () => {
    let authorization: string | null = null;
    let savedHeader: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        savedHeader = request.headers.get('x-saved-secret');
        return Response.json({ data: [{ id: 'fresh-header-model' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest({
          draft: {
            baseURL: `http://127.0.0.1:${upstream.port}/v1`,
            headers: { authorization: 'Bearer fresh-header-secret', 'x-saved-secret': '****' },
            id: 'saved',
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
          },
          persistedProviderId: 'saved',
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ ok: true, models: ['fresh-header-model'] });
      expect(authorization).toBe('Bearer fresh-header-secret');
      expect(savedHeader).toBeNull();
      expect(text).not.toMatch(/fresh-header-secret|saved-secret|saved-header/u);
    } finally {
      await upstream.stop(true);
    }
  });

  test('does not treat a persisted ordinary API header as fresh credentials for a changed destination', async () => {
    let requests = 0;
    let authorization: string | null = null;
    let savedHeader: string | null = null;
    const attacker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        requests += 1;
        authorization = request.headers.get('authorization');
        savedHeader = request.headers.get('x-saved-secret');
        return Response.json({ data: [{ id: 'attacker-model' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest({
          draft: {
            baseURL: `http://127.0.0.1:${attacker.port}/v1`,
            headers: { 'content-type': 'application/json' },
            id: 'saved',
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
          },
          persistedProviderId: 'saved',
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: { code: 'fresh_credentials_required', recoverable: true },
      });
      expect(requests).toBe(0);
      expect(authorization).toBeNull();
      expect(savedHeader).toBeNull();
      expect(text).not.toContain('saved-secret');
      expect(text).not.toContain('saved-header');
    } finally {
      await attacker.stop(true);
    }
  });

  test('does not restore API secrets or contact a changed persisted Provider proxy', async () => {
    let requests = 0;
    let authorization: string | null = null;
    let savedHeader: string | null = null;
    const attackerProxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        requests += 1;
        authorization = request.headers.get('authorization');
        savedHeader = request.headers.get('x-saved-secret');
        return Response.json({ data: [{ id: 'attacker-model' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest({
          draft: {
            baseURL: 'http://saved.example/v1',
            id: 'saved',
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            proxy: `http://127.0.0.1:${attackerProxy.port}`,
          },
          persistedProviderId: 'saved',
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: { code: 'fresh_credentials_required', recoverable: true },
      });
      expect(requests).toBe(0);
      expect(authorization).toBeNull();
      expect(savedHeader).toBeNull();
      expect(text).not.toContain('saved-secret');
      expect(text).not.toContain('saved-header');
    } finally {
      await attackerProxy.stop(true);
    }
  });

  test('does not treat AI SDK tokenCount as fresh credentials for a changed destination', async () => {
    let requests = 0;
    let authorization: string | null = null;
    const attacker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        requests += 1;
        authorization = request.headers.get('authorization');
        return new Response(
          'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/test',
        jsonRequest({
          draft: {
            id: 'saved-sdk',
            kind: 'ai-sdk',
            models: ['saved-sdk-model'],
            options: {
              apiKey: '****',
              baseURL: `http://127.0.0.1:${attacker.port}/v1`,
              headers: { 'x-saved-sdk-secret': '****' },
              name: 'saved-sdk',
              tokenCount: '1',
            },
            packageName: '@ai-sdk/openai-compatible',
          },
          model: 'saved-sdk-model',
          persistedProviderId: 'saved-sdk',
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: { code: 'fresh_credentials_required', recoverable: true },
      });
      expect(requests).toBe(0);
      expect(authorization).toBeNull();
      expect(text).not.toContain('saved-sdk-secret');
    } finally {
      await attacker.stop(true);
    }
  });

  test('does not restore AI SDK secrets or contact a changed persisted Provider proxy', async () => {
    let requests = 0;
    let authorization: string | null = null;
    const attackerProxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        requests += 1;
        authorization = request.headers.get('authorization');
        return new Response(
          'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/test',
        jsonRequest({
          draft: {
            id: 'saved-sdk',
            kind: 'ai-sdk',
            models: ['saved-sdk-model'],
            options: {
              apiKey: '****',
              baseURL: 'http://saved-sdk.example/v1',
              headers: { 'x-saved-sdk-secret': '****' },
              name: 'saved-sdk',
            },
            packageName: '@ai-sdk/openai-compatible',
            proxy: `http://127.0.0.1:${attackerProxy.port}`,
          },
          model: 'saved-sdk-model',
          persistedProviderId: 'saved-sdk',
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: { code: 'fresh_credentials_required', recoverable: true },
      });
      expect(requests).toBe(0);
      expect(authorization).toBeNull();
      expect(text).not.toContain('saved-sdk-secret');
    } finally {
      await attackerProxy.stop(true);
    }
  });

  test('uses only fresh AI SDK options for a changed target', async () => {
    let authorization: string | null = null;
    let freshHeader: string | null = null;
    let savedHeader: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        authorization = request.headers.get('authorization');
        freshHeader = request.headers.get('x-fresh-sdk');
        savedHeader = request.headers.get('x-saved-sdk-secret');
        return new Response(
          'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/test',
        jsonRequest({
          draft: {
            id: 'saved-sdk',
            kind: 'ai-sdk',
            models: ['saved-sdk-model'],
            options: {
              apiKey: 'fresh-sdk-secret',
              baseURL: `http://127.0.0.1:${upstream.port}/v1`,
              headers: { 'x-fresh-sdk': 'fresh-sdk-header', 'x-saved-sdk-secret': '****' },
              name: 'changed-sdk',
            },
            packageName: '@ai-sdk/openai-compatible',
            proxy: false,
          },
          model: 'saved-sdk-model',
          persistedProviderId: 'saved-sdk',
        }),
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ ok: true });
      expect(authorization).toBe('Bearer fresh-sdk-secret');
      expect(freshHeader).toBe('fresh-sdk-header');
      expect(savedHeader).toBeNull();
      expect(text).not.toMatch(/fresh-sdk-secret|saved-sdk-secret|saved-sdk-header/u);
    } finally {
      await upstream.stop(true);
    }
  });

  test('tests exactly the selected enabled API model', async () => {
    let requestedModel: unknown;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { readonly model?: unknown };
        requestedModel = body.model;
        return Response.json({ choices: [] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/test',
        jsonRequest({
          draft: {
            baseURL: `http://127.0.0.1:${upstream.port}`,
            id: 'api-test',
            kind: 'api',
            models: ['enabled-model', 'other-model'],
            protocol: ProviderProtocol.OpenAICompatible,
          },
          model: 'enabled-model',
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(requestedModel).toBe('enabled-model');
    } finally {
      await upstream.stop(true);
    }
  });

  test('does not send a test request for a model outside the enabled draft models', async () => {
    let requests = 0;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests += 1;
        return new Response(null, { status: 204 });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/test',
        jsonRequest({
          draft: {
            baseURL: `http://127.0.0.1:${upstream.port}`,
            id: 'api-test',
            kind: 'api',
            models: ['enabled-model'],
            protocol: ProviderProtocol.OpenAICompatible,
          },
          model: 'disabled-model',
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: 'model_not_enabled', recoverable: true },
      });
      expect(requests).toBe(0);
    } finally {
      await upstream.stop(true);
    }
  });

  test('performs one selected-model request for an AI SDK draft', async () => {
    let requests = 0;
    let requestedModel: unknown;
    let transformedHeader: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests += 1;
        transformedHeader = request.headers.get('x-draft-transform');
        const body = (await request.json()) as { readonly model?: unknown };
        requestedModel = body.model;
        return new Response(
          'data: {"id":"x","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n' +
            'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/test',
        jsonRequest({
          draft: {
            id: 'sdk-test',
            kind: 'ai-sdk',
            models: ['sdk-model'],
            options: {
              apiKey: 'sdk-secret',
              baseURL: `http://127.0.0.1:${upstream.port}/v1`,
              name: 'sdk-test',
            },
            packageName: '@ai-sdk/openai-compatible',
            transforms: {
              request: [
                {
                  when: { 'request.targetProtocol': { $eq: ProviderProtocol.OpenAICompatible } },
                  update: [
                    {
                      $set: {
                        'request.headers': {
                          $setField: {
                            field: 'x-draft-transform',
                            input: '$request.headers',
                            value: 'applied',
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
          model: 'sdk-model',
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(requests).toBe(1);
      expect(requestedModel).toBe('sdk-model');
      expect(transformedHeader).toBe('applied');
    } finally {
      await upstream.stop(true);
    }
  });
});
