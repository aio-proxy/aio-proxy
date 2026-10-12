import { describe, expect, test } from 'bun:test';

import { createProviderV4Invoke, type AiSdkProviderInstance } from '@aio-proxy/core';
import chatGPTPlugin from '@aio-proxy/plugin-openai-chatgpt';
import type { OAuthRuntimeResult, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { createServer } from '#server-test-lifecycle';

import type { ServerState } from '../server-state';
import { createRoutes } from '../server/create-routes';

describe('ChatGPT sessions through protocol conversion', () => {
  test.each(['header', 'metadata', 'prompt-cache'] as const)(
    'keeps %s sessions stable from Chat Completions HTTP ingress to ChatGPT Responses',
    async (source) => {
      const upstream: { headers: Headers; body: Record<string, unknown> }[] = [];
      const fetcher: RuntimeFetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          upstream.push({ headers: request.headers, body: await request.json() });
          expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
          return new Response(
            `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_test', created_at: 1, model: 'gpt-5.5' } })}\n\ndata: ${JSON.stringify(
              {
                type: 'response.completed',
                response: {
                  id: 'resp_test',
                  created_at: 1,
                  model: 'gpt-5.5',
                  status: 'completed',
                  incomplete_details: null,
                  output: [],
                  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 1 },
                },
              },
            )}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      let runtimePromise: Promise<OAuthRuntimeResult> | undefined;
      await chatGPTPlugin.setup(
        {
          oauth: {
            register(adapter) {
              runtimePromise = adapter.createRuntime({
                credentials: {
                  read: async () => ({
                    revision: 1,
                    value: {
                      accessToken: 'upstream-token',
                      accountId: 'test-account',
                      expiresAt: Date.now() + 60_000,
                      refreshToken: 'unused',
                    },
                  }),
                  refresh: async () => {
                    throw new Error('fresh credential must not refresh');
                  },
                },
                options: {},
                catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
                fetch: fetcher,
              });
            },
          },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        },
        { userAgent: 'session-integration-test' },
      );
      if (runtimePromise === undefined) throw new Error('plugin did not register OAuth runtime');
      const runtime = await runtimePromise;
      const provider: AiSdkProviderInstance = {
        id: 'chatgpt',
        kind: 'ai-sdk',
        models: ['gpt-5.5'],
        alias: {},
        invoke: createProviderV4Invoke('chatgpt', runtime.provider),
      };
      let state: ServerState | undefined;
      const app = await createServer({
        config: { providers: {} },
        providerInstances: [provider],
        __test: {
          createRoutes: (source, ...args) => {
            state = source;
            return createRoutes(source, ...args);
          },
        },
      });
      for (const session of ['first-session', 'first-session', 'other-session']) {
        const response = await app.request('/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(source === 'header' ? { 'session-id': session } : {}) },
          body: JSON.stringify({
            model: 'gpt-5.5',
            stream: false,
            messages: [{ role: 'user', content: 'hello' }],
            ...(source === 'metadata' ? { metadata: { session_id: session } } : {}),
            ...(source === 'prompt-cache' ? { prompt_cache_key: session } : {}),
          }),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.choices).toHaveLength(1);
        expect(body.usage.prompt_tokens).toBe(100);
        expect(body.usage.completion_tokens).toBe(1);
      }
      expect(upstream).toHaveLength(3);
      const sessions = upstream.map((call) => call.headers.get('session-id'));
      expect(sessions[0]).toBeTruthy();
      expect(sessions[0]).toBe(sessions[1]);
      expect(sessions[2]).not.toBe(sessions[0]);
      expect(upstream.every((call) => call.headers.get('authorization') === 'Bearer upstream-token')).toBe(true);
      expect(upstream.every((call) => call.headers.get('ChatGPT-Account-Id') === 'test-account')).toBe(true);
      expect(upstream.every((call) => call.body.store === false && Array.isArray(call.body.input))).toBe(true);
      // Keep the database open until asynchronous request recording has finished.
      if (state === undefined) throw new Error('server state unavailable');
      const deadline = Date.now() + 2000;
      while (state.traceStore.list({ pageSize: 10, outcome: 'success' }).items.length < 3 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(state.traceStore.list({ pageSize: 10, outcome: 'success' }).items).toHaveLength(3);
    },
  );
});
