import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigSchema, ProviderProtocol } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import type { ServerState } from '../../server-state';
import { createDashboardRoutes } from '../config';
import { resolveProviderDraft } from './provider-draft-operations';

const jsonRequest = (body: unknown, method: 'POST' | 'QUERY' = 'POST'): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method,
});

describe('draft Provider catalog and test routes', () => {
  let directory: string;
  let state: ServerState;
  let routes: ReturnType<typeof createDashboardRoutes>;
  let probedModel: string | undefined;

  beforeEach(async () => {
    probedModel = undefined;
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
          'saved-oauth': { kind: 'oauth', plugin: '@example/oauth', capability: 'default' },
          'saved-proxied': {
            baseURL: 'https://saved.example/v1',
            kind: 'api',
            models: ['saved-model'],
            protocol: ProviderProtocol.OpenAICompatible,
            proxy: 'https://saved-proxy.example:8443',
          },
          'saved-sdk': {
            alias: { 'sdk-public': { model: 'saved-sdk-model' } },
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
      // The two lists MUST differ: `models` is the runtime's already-filtered SAVED
      // whitelist, `upstreamMetadata` keys are the full discovered catalog, and the gate
      // must read the latter. Make them equal and `Object.keys(runtime.upstreamMetadata)`
      // and `runtime.models` become indistinguishable, so nothing catches a gate wired to
      // the saved whitelist — exactly the unsaved-whitelist-edit case this supports.
      providerInstances: [
        {
          id: 'saved-oauth',
          kind: 'oauth',
          enabled: true,
          models: ['disc-a'],
          upstreamMetadata: { 'disc-a': {}, 'disc-b': {} },
          model: {
            // Record the requested id: the transport must be invoked with the model the
            // user asked about, or the button reports "works" for a model it never called.
            invoke: async function* (input: { readonly modelId: string }) {
              probedModel = input.modelId;
              yield { type: 'text-delta', delta: 'pong' };
            },
          },
        } as never,
      ],
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
        jsonRequest(
          {
            draft: {
              apiKey: 'draft-secret',
              baseURL: `http://127.0.0.1:${upstream.port}/v1`,
              id: 'unsaved',
              kind: 'api',
              protocol: ProviderProtocol.OpenAICompatible,
            },
          },
          'QUERY',
        ),
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ ok: true, models: ['model-b', 'model-a'] });
      expect(authorization).toBe('Bearer draft-secret');
      expect(text).not.toContain('draft-secret');
      expect(state.currentConfig().providers.map(({ id }) => id)).toEqual([
        'saved',
        'saved-oauth',
        'saved-proxied',
        'saved-sdk',
      ]);
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
        jsonRequest(
          {
            draft: {
              baseURL: `http://127.0.0.1:${upstream.port}`,
              id: 'gemini-draft',
              kind: 'api',
              protocol: ProviderProtocol.Gemini,
            },
          },
          'QUERY',
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, models: ['gemini-2.5-flash'] });
      expect(pathname).toBe('/v1beta/models');
    } finally {
      await upstream.stop(true);
    }
  });

  test('imports every page from a Gemini catalog', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const pageToken = new URL(request.url).searchParams.get('pageToken');
        return Response.json(
          pageToken === null
            ? { models: [{ name: 'models/gemini-first' }], nextPageToken: 'second-page' }
            : { models: [{ name: 'models/gemini-second' }] },
        );
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              baseURL: `http://127.0.0.1:${upstream.port}`,
              id: 'gemini-draft',
              kind: 'api',
              protocol: ProviderProtocol.Gemini,
            },
          },
          'QUERY',
        ),
      );

      expect(await response.json()).toEqual({ ok: true, models: ['gemini-first', 'gemini-second'] });
    } finally {
      await upstream.stop(true);
    }
  });

  test('imports every page from an Anthropic catalog', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const afterId = new URL(request.url).searchParams.get('after_id');
        return Response.json(
          afterId === null
            ? { data: [{ id: 'claude-first' }], has_more: true, last_id: 'claude-first' }
            : { data: [{ id: 'claude-second' }], has_more: false },
        );
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              baseURL: `http://127.0.0.1:${upstream.port}`,
              id: 'anthropic-draft',
              kind: 'api',
              protocol: ProviderProtocol.Anthropic,
            },
          },
          'QUERY',
        ),
      );

      expect(await response.json()).toEqual({ ok: true, models: ['claude-first', 'claude-second'] });
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
        jsonRequest(
          {
            draft: {
              baseURL: `http://127.0.0.1:${upstream.port}`,
              id: 'unavailable',
              kind: 'api',
              protocol: ProviderProtocol.Anthropic,
            },
          },
          'QUERY',
        ),
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
      jsonRequest(
        {
          draft: {
            id: 'sdk-draft',
            kind: 'ai-sdk',
            packageName: '@ai-sdk/openai-compatible',
          },
        },
        'QUERY',
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'catalog_unsupported', recoverable: true },
    });
  });

  test('lists an ai-sdk draft catalog from options.baseURL with bearer auth', async () => {
    let authorization: string | null = null;
    let pathname = '';
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        pathname = new URL(request.url).pathname;
        return Response.json({ data: [{ id: 'sdk-model-a' }, { id: 'sdk-model-b' }] });
      },
    });
    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              id: 'unsaved-sdk',
              kind: 'ai-sdk',
              packageName: '@ai-sdk/openai-compatible',
              options: { apiKey: 'sdk-secret', baseURL: `http://127.0.0.1:${upstream.port}/v1` },
            },
          },
          'QUERY',
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, models: ['sdk-model-a', 'sdk-model-b'] });
      expect(authorization).toBe('Bearer sdk-secret');
      expect(pathname).toBe('/v1/models');
    } finally {
      await upstream.stop(true);
    }
  });

  // A *missing* options.baseURL is already pinned by the existing test at
  // `provider-draft.test.ts:233` ("returns a recoverable unsupported catalog result
  // for an AI SDK draft", no options at all) — do not add a second test for that.
  // This one pins the blank-string branch, which nothing else covers: without the
  // `.trim() === ''` guard a blank baseURL fetches "/models" and degrades to
  // catalog_unavailable ("we tried and it broke") instead of catalog_unsupported
  // ("you have not configured a listing endpoint").
  test('an ai-sdk draft with a blank options.baseURL still returns catalog_unsupported', async () => {
    const response = await routes.request(
      '/providers/draft/catalog',
      jsonRequest({ draft: { id: 'unsaved-sdk', kind: 'ai-sdk', options: { apiKey: 'x', baseURL: '   ' } } }, 'QUERY'),
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'catalog_unsupported', recoverable: true },
    });
  });

  test('an ai-sdk endpoint that is not OpenAI-shaped returns catalog_unavailable', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ unexpected: true }),
    });
    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: { id: 'unsaved-sdk', kind: 'ai-sdk', options: { baseURL: `http://127.0.0.1:${upstream.port}/v1` } },
          },
          'QUERY',
        ),
      );
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: 'catalog_unavailable', recoverable: true },
      });
    } finally {
      await upstream.stop(true);
    }
  });

  // A configured Authorization must beat options.apiKey, the way upstreamHeaders
  // (core/.../api.ts:98-104), the schema contract (types/provider.ts:94) and
  // @ai-sdk/openai-compatible all resolve it. Deliberately spelled with a capital A: an
  // object spread keeps both casings and fetch comma-joins them into one malformed
  // credential, so this asserts the single-value outcome that Headers.set guarantees.
  test('a configured Authorization header overrides options.apiKey', async () => {
    let authorization: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        return Response.json({ data: [{ id: 'sdk-model-a' }] });
      },
    });
    try {
      await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              id: 'unsaved-sdk',
              kind: 'ai-sdk',
              options: {
                apiKey: 'placeholder',
                baseURL: `http://127.0.0.1:${upstream.port}/v1`,
                headers: { Authorization: 'Bearer real-token' },
              },
            },
          },
          'QUERY',
        ),
      );
      expect(authorization).toBe('Bearer real-token');
    } finally {
      await upstream.stop(true);
    }
  });

  // The ai-sdk loader duplicates the api loader's non-ok handling (its equivalent test is
  // 'returns a recoverable catalog failure without reflecting the upstream body') and
  // carries the same guarantee: an upstream error body never reaches the dashboard.
  test('an ai-sdk catalog error is recoverable and does not reflect the upstream body', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('sdk-upstream-secret-body', { status: 401 }),
    });
    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              id: 'unsaved-sdk',
              kind: 'ai-sdk',
              options: { apiKey: 'wrong-key', baseURL: `http://127.0.0.1:${upstream.port}/v1` },
            },
          },
          'QUERY',
        ),
      );
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ ok: false, error: { code: 'catalog_unavailable', recoverable: true } });
      expect(text).not.toContain('sdk-upstream-secret-body');
      expect(text).not.toContain('wrong-key');
    } finally {
      await upstream.stop(true);
    }
  });

  test('an identity-changing edit reaches the upstream instead of short-circuiting', async () => {
    const response = await routes.request(
      '/providers/draft/catalog',
      jsonRequest(
        {
          draft: {
            baseURL: 'http://127.0.0.1:1/v2',
            id: 'saved',
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
          },
          persistedProviderId: 'saved',
        },
        'QUERY',
      ),
    );

    // Reaches the upstream fetch and fails there — no longer short-circuited by fresh_credentials_required.
    expect(await response.json()).toEqual({ ok: false, error: { code: 'catalog_unavailable', recoverable: true } });
  });

  test('an identity-changing edit sends no persisted credential to the new destination', async () => {
    let authorization: string | null = null;
    let savedHeader: string | null = null;
    const relocated = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        savedHeader = request.headers.get('x-saved-secret');
        return Response.json({ data: [{ id: 'relocated-model' }] });
      },
    });

    try {
      // The draft moves the destination and supplies no credentials of its own, so the
      // persisted merge must stay gated: an attacker-chosen baseURL never harvests the
      // stored apiKey or headers that the edit-view now hands the editor in full.
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              baseURL: `http://127.0.0.1:${relocated.port}/v1`,
              id: 'saved',
              kind: 'api',
              protocol: ProviderProtocol.OpenAICompatible,
            },
            persistedProviderId: 'saved',
          },
          'QUERY',
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, models: ['relocated-model'] });
      expect(authorization).toBeNull();
      expect(savedHeader).toBeNull();
    } finally {
      await relocated.stop(true);
    }
  });

  test('a custom stored header is not sent to a changed destination', async () => {
    let customHeader: string | null = null;
    const relocated = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        customHeader = request.headers.get('x-auth');
        return Response.json({ data: [{ id: 'relocated-model' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              apiKey: 'saved-secret',
              baseURL: `http://127.0.0.1:${relocated.port}/v1`,
              headers: { 'x-auth': 'saved-header', 'x-saved-secret': 'saved-header' },
              id: 'saved',
              kind: 'api',
              protocol: ProviderProtocol.OpenAICompatible,
            },
            persistedProviderId: 'saved',
          },
          'QUERY',
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, models: ['relocated-model'] });
      expect(customHeader).toBeNull();
    } finally {
      await relocated.stop(true);
    }
  });

  test('prefilled stored credentials are not sent to a changed destination', async () => {
    let authorization: string | null = null;
    let savedHeader: string | null = null;
    const relocated = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        savedHeader = request.headers.get('x-saved-secret');
        return Response.json({ data: [{ id: 'relocated-model' }] });
      },
    });

    try {
      const response = await routes.request(
        '/providers/draft/catalog',
        jsonRequest(
          {
            draft: {
              apiKey: 'saved-secret',
              baseURL: `http://127.0.0.1:${relocated.port}/v1`,
              headers: { 'x-saved-secret': 'saved-header' },
              id: 'saved',
              kind: 'api',
              protocol: ProviderProtocol.OpenAICompatible,
            },
            persistedProviderId: 'saved',
          },
          'QUERY',
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, models: ['relocated-model'] });
      expect(authorization).toBeNull();
      expect(savedHeader).toBeNull();
    } finally {
      await relocated.stop(true);
    }
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

  test('a shared endpoints object keeps the same identity as an equivalent stored pair', () => {
    const resolved = resolveProviderDraft(
      state,
      {
        endpoints: { baseURL: 'http://saved.example/v1', protocol: [ProviderProtocol.OpenAICompatible] },
        id: 'saved',
        kind: 'api',
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

  test('an ai-sdk draft carrying the real persisted options keeps the persisted identity', () => {
    const resolved = resolveProviderDraft(
      state,
      {
        id: 'saved-sdk',
        kind: 'ai-sdk',
        options: {
          apiKey: 'saved-sdk-secret',
          baseURL: 'http://saved-sdk.example/v1',
          headers: { 'x-saved-sdk-secret': 'saved-sdk-header' },
          name: 'saved-sdk',
        },
        packageName: '@ai-sdk/openai-compatible',
        proxy: null,
      },
      'saved-sdk',
    );

    // Same identity, so the merge restores what the draft omitted; an identity change would drop the alias.
    expect(resolved).toMatchObject({
      ok: true,
      provider: { alias: { 'sdk-public': { model: 'saved-sdk-model', preserve: false } } },
    });
  });

  test('accepts a freshly entered sensitive AI SDK option for a changed target', () => {
    const resolved = resolveProviderDraft(
      state,
      {
        id: 'saved-sdk',
        kind: 'ai-sdk',
        options: {
          accessToken: 'fresh-sdk-access-token',
          apiKey: '****',
          baseURL: 'http://changed-sdk.example/v1',
          name: 'changed-sdk',
        },
        packageName: '@ai-sdk/openai-compatible',
      },
      'saved-sdk',
    );

    expect(resolved).toMatchObject({
      ok: true,
      provider: { options: { accessToken: 'fresh-sdk-access-token' } },
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
        jsonRequest(
          {
            draft: {
              apiKey: 'fresh-secret',
              baseURL: `http://127.0.0.1:${upstream.port}/v1`,
              headers: { 'x-fresh': 'fresh-header' },
              id: 'saved',
              kind: 'api',
              protocol: ProviderProtocol.OpenAICompatible,
              proxy: false,
            },
            persistedProviderId: 'saved',
          },
          'QUERY',
        ),
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
        jsonRequest(
          {
            draft: {
              baseURL: `http://127.0.0.1:${upstream.port}/v1`,
              headers: { authorization: 'Bearer fresh-header-secret' },
              id: 'saved',
              kind: 'api',
              protocol: ProviderProtocol.OpenAICompatible,
            },
            persistedProviderId: 'saved',
          },
          'QUERY',
        ),
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
              headers: { 'x-fresh-sdk': 'fresh-sdk-header' },
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

  test('tests an oauth draft model against the live runtime', async () => {
    const response = await routes.request(
      '/providers/draft/test',
      jsonRequest({
        draft: { kind: 'oauth', id: 'saved-oauth', enabled: true, proxy: null, models: [] },
        persistedProviderId: 'saved-oauth',
        model: 'disc-a',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(probedModel).toBe('disc-a');
  });

  // The gate reads the DISCOVERED catalog with the DRAFT's whitelist, not the saved
  // `runtime.models` (which is only ['disc-a']). Swap the implementation to
  // `runtime.models` and this is the test that goes red: an unsaved whitelist edit
  // naming a discovered-but-not-yet-saved model must be testable before saving.
  test('an oauth draft whitelist beats the saved one for a discovered model', async () => {
    const response = await routes.request(
      '/providers/draft/test',
      jsonRequest({
        draft: { kind: 'oauth', id: 'saved-oauth', enabled: true, proxy: null, models: ['disc-b'] },
        persistedProviderId: 'saved-oauth',
        model: 'disc-b',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(probedModel).toBe('disc-b');
  });

  // The gate's other direction, and the one that matters for exposure: a non-empty draft whitelist
  // must RESTRICT. Kills the mutant that drops the whitelist and gates on the discovered catalog alone
  // (`exposedModelIds(catalogIds, undefined)`), which is otherwise green on every oauth test here —
  // the empty-whitelist case passes via "whole catalog" and the unknown-model case still 400s on
  // catalog membership. `disc-b` is discovered, so only the whitelist can reject it.
  test('an oauth draft whitelist restricts a discovered model it omits', async () => {
    const response = await routes.request(
      '/providers/draft/test',
      jsonRequest({
        draft: { kind: 'oauth', id: 'saved-oauth', enabled: true, proxy: null, models: ['disc-a'] },
        persistedProviderId: 'saved-oauth',
        model: 'disc-b',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'model_not_enabled', recoverable: true } });
    expect(probedModel).toBeUndefined();
  });

  test('an oauth draft with an empty whitelist can test any discovered model, but not an unknown one', async () => {
    const response = await routes.request(
      '/providers/draft/test',
      jsonRequest({
        draft: { kind: 'oauth', id: 'saved-oauth', enabled: true, proxy: null, models: [] },
        persistedProviderId: 'saved-oauth',
        model: 'not-discovered',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'model_not_enabled', recoverable: true } });
  });

  test('an oauth draft naming an id with no persisted provider fails with persisted_provider_not_found', async () => {
    const response = await routes.request(
      '/providers/draft/test',
      jsonRequest({
        draft: { kind: 'oauth', id: 'ghost', enabled: true, proxy: null },
        persistedProviderId: 'ghost',
        model: 'disc-a',
      }),
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'persisted_provider_not_found', recoverable: true },
    });
  });

  // The contract, not the line that happens to enforce it: an oauth draft is testable
  // only against its persisted account. Today the candidate fails ProviderSchema first
  // (no plugin/capability), so this passes through the `!parsed.success` arm rather than
  // the oauth guard below it — that is fine. If plugin/capability ever gain defaults,
  // this test is what stops a credential-less oauth draft from reaching a transport.
  test('a fresh oauth draft with no persisted provider is not testable', async () => {
    const response = await routes.request(
      '/providers/draft/test',
      jsonRequest({
        draft: { kind: 'oauth', id: 'fresh-oauth', enabled: true, proxy: null, models: [] },
        model: 'disc-a',
      }),
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'persisted_provider_mismatch', recoverable: true },
    });
    expect(probedModel).toBeUndefined();
  });
});
