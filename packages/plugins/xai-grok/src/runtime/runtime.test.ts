import { describe, expect, test } from 'bun:test';

import type { CredentialPort, ModelCatalog, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { XAIGrokCredential } from '../schema';
import { createXAIGrokDynamicFetch, createXAIGrokRuntime } from './runtime';

describe('xAI Grok runtime', () => {
  test('routes the final xAI Grok request through the host fetch', async () => {
    const originalFetch = globalThis.fetch;
    const controlRequests: Request[] = [];
    const modelRequests: Request[] = [];
    globalThis.fetch = async () => {
      throw new Error('unexpected global fetch');
    };

    try {
      const runtime = await createXAIGrokRuntime({
        credentials: port(),
        options: {},
        catalog: emptyCatalog(),
        fetch: (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
          const traffic = init?.aioProxy?.traffic ?? 'model';
          const request = new Request(input, init);
          if (traffic === 'control') {
            controlRequests.push(request);
            throw new Error('unexpected control fetch');
          }
          modelRequests.push(request);
          return Response.json(openAIResponse());
        }) as RuntimeFetch,
      });

      await runtime.provider.languageModel('grok-4.5').doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(controlRequests).toEqual([]);
    expect(modelRequests).toHaveLength(1);
    const request = modelRequests[0];
    expect(request?.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(request?.headers.get('authorization')).toBe('Bearer access-token');
    expect(request?.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(request?.headers.get('x-grok-client-version')).toBe('0.2.93');
    expect(request?.headers.get('user-agent')).toBe('xai-grok-workspace/0.2.93');
  });

  test('exposes Responses language models without raw capability', async () => {
    const runtime = await createXAIGrokRuntime({
      credentials: port(),
      options: {},
      catalog: emptyCatalog(),
      fetch: globalThis.fetch,
    });
    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(runtime.provider.languageModel('grok-4.5').modelId).toBe('grok-4.5');
    expect(runtime.raw).toBeUndefined();
  });

  test('injects CLI identity and compiles custom Responses tools before dispatch', async () => {
    let captured: Request | undefined;
    let observedSignal: AbortSignal | null | undefined;
    const controller = new AbortController();
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        observedSignal = init?.signal;
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });
    await dynamicFetch('https://cli-chat-proxy.grok.com/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer placeholder', 'x-keep': 'yes' },
      body: JSON.stringify({
        model: 'grok-4.5',
        reasoning: { effort: 'high', summary: 'auto' },
        tools: [
          { type: 'custom', name: 'exec', format: { type: 'text' } },
          { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        ],
        tool_choice: { type: 'custom', name: 'exec' },
        input: [
          { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'pwd' },
          { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' },
        ],
      }),
      signal: controller.signal,
    });
    expect(captured?.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(captured?.headers.get('authorization')).toBe('Bearer access-token');
    expect(captured?.headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(captured?.headers.get('x-grok-client-version')).toBe('0.2.93');
    expect(captured?.headers.get('user-agent')).toBe('xai-grok-workspace/0.2.93');
    expect(captured?.headers.get('x-keep')).toBe('yes');
    expect(await captured?.json()).toEqual({
      model: 'grok-4.5',
      reasoning: { effort: 'high' },
      tools: [
        {
          type: 'function',
          name: 'exec',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false,
          },
        },
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
      ],
      tool_choice: { type: 'function', name: 'exec' },
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"input":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    });
    expect(observedSignal).toBe(controller.signal);
  });
});

function port(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: { accessToken: 'access-token', refreshToken: 'refresh', expiresAt: 4_000_000_000_000 },
    }),
    refresh: async () => {
      throw new Error('fresh credential must not refresh');
    },
  };
}

function emptyCatalog(): ModelCatalog {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

function openAIResponse() {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'grok-4.5',
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1,
    },
    user: null,
    metadata: {},
  };
}
