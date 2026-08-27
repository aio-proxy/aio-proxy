import { describe, expect, spyOn, test } from 'bun:test';

import type { CredentialPort, ModelCatalog, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { streamAiSdkText } from '../../../../core/src/ai-sdk-bridge';
import { writeOpenAIResponsesResponse } from '../../../../core/src/egress/openai-responses';
import { openAIResponsesAdapter } from '../../../../core/src/protocol/openai-responses';
import { ProviderProtocol } from '../../../../types/src';
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
    expect(request?.headers.get('x-grok-client-version')).toBe('0.2.120');
    expect(request?.headers.get('x-grok-client-identifier')).toBe('grok-shell');
    expect(request?.headers.get('x-authenticateresponse')).toBe('authenticate-response');
    expect(request?.headers.get('user-agent')).toBe('xai-grok-workspace/0.2.120');
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

  test('injects CLI identity, sanitizes Responses fields, and compiles custom tools before dispatch', async () => {
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
        previous_response_id: 'resp_old',
        reasoning: { effort: 'high', summary: 'auto' },
        tools: [
          { type: 'custom', name: 'exec', format: { type: 'text' } },
          {
            type: 'function',
            name: 'lookup',
            strict: true,
            parameters: {
              type: 'object',
              oneOf: [{ $ref: '#/$defs/by_id' }, { $ref: '#/$defs/by_name' }],
              $defs: {
                by_id: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                  additionalProperties: false,
                },
                by_name: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                  additionalProperties: false,
                },
              },
            },
          },
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
    expect(captured?.headers.get('x-grok-client-version')).toBe('0.2.120');
    expect(captured?.headers.get('x-grok-client-identifier')).toBe('grok-shell');
    expect(captured?.headers.get('x-authenticateresponse')).toBe('authenticate-response');
    expect(captured?.headers.get('user-agent')).toBe('xai-grok-workspace/0.2.120');
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
        {
          type: 'function',
          name: 'lookup',
          strict: true,
          parameters: {
            type: 'object',
            oneOf: [
              {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
                additionalProperties: false,
              },
            ],
          },
        },
      ],
      tool_choice: { type: 'function', name: 'exec' },
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"input":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    });
    expect(observedSignal).toBe(controller.signal);
  });

  test('compiles nested namespace and additional_tools custom declarations before dispatch', async () => {
    let captured: Request | undefined;
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });
    await dynamicFetch('https://cli-chat-proxy.grok.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'grok-4.5',
        tools: [
          {
            type: 'namespace',
            name: 'shell',
            tools: [
              { type: 'custom', name: 'exec', format: { type: 'text' } },
              { type: 'function', name: 'lookup', parameters: { type: 'object' } },
            ],
          },
        ],
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              { type: 'custom', name: 'apply_patch', format: { type: 'text' } },
              { type: 'function', name: 'search', parameters: { type: 'object' } },
            ],
          },
        ],
      }),
    });
    expect(await captured?.json()).toEqual({
      model: 'grok-4.5',
      tools: [
        {
          type: 'namespace',
          name: 'shell',
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
        },
      ],
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'function',
              name: 'apply_patch',
              parameters: {
                type: 'object',
                properties: { input: { type: 'string' } },
                required: ['input'],
                additionalProperties: false,
              },
            },
            { type: 'function', name: 'search', parameters: { type: 'object' } },
          ],
        },
      ],
    });
  });

  test('compiles grammar custom tools, tool choice, and history before dispatch', async () => {
    let hostCalls = 0;
    let captured: Request | undefined;
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        hostCalls += 1;
        captured = new Request(input, init);
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });
    const response = await dynamicFetch('https://cli-chat-proxy.grok.com/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer placeholder' },
      body: JSON.stringify({
        model: 'grok-4.6',
        tools: [
          {
            type: 'custom',
            name: 'apply_patch',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: PATCH' },
          },
        ],
        tool_choice: { type: 'custom', name: 'apply_patch' },
        input: [
          {
            type: 'custom_tool_call',
            call_id: 'call_1',
            name: 'apply_patch',
            input: '*** Begin Patch',
          },
          { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' },
        ],
      }),
    });
    expect(hostCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(await captured?.json()).toEqual({
      model: 'grok-4.6',
      tools: [
        {
          type: 'function',
          name: 'apply_patch',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'function', name: 'apply_patch' },
      input: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'apply_patch',
          arguments: '{"input":"*** Begin Patch"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    });
  });

  test('round trips a target-materialized grammar tool through the xAI function fallback', async () => {
    let captured: Request | undefined;
    const runtime = await createXAIGrokRuntime({
      credentials: port(),
      options: {},
      catalog: emptyCatalog(),
      fetch: (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
        captured = new Request(input, init);
        return functionCallStream('apply_patch', '{"input":"*** Begin Patch"}');
      }) as RuntimeFetch,
    });
    const raw = new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-4.6',
        input: 'apply a patch',
        stream: true,
        tools: [
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'Apply a short patch',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: PATCH' },
          },
        ],
      }),
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});
    const invocation = openAIResponsesAdapter.modelInvocationForTarget(
      openAIResponsesAdapter.modelInvocation(parsed, {}),
      ProviderProtocol.OpenAIResponse,
      new Set(),
    );
    const result = streamAiSdkText({
      model: runtime.provider.languageModel('grok-4.6'),
      messages: invocation.messages,
      settings: invocation.settings,
      tools: invocation.tools,
    });

    const response = await writeOpenAIResponsesResponse(result.fullStream, { modelId: 'grok-4.6' });
    const hostBody = (await captured?.json()) as { tools?: unknown[] };

    expect(hostBody.tools).toEqual([
      {
        type: 'function',
        name: 'apply_patch',
        description: 'Apply a short patch',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
    ]);
    expect(JSON.stringify(hostBody)).not.toContain('start: PATCH');
    expect(response.output).toContainEqual(
      expect.objectContaining({
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch',
      }),
    );
  });

  test('compiles nested grammar custom tools before dispatch', async () => {
    let hostCalls = 0;
    let captured: Request | undefined;
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        hostCalls += 1;
        captured = new Request(input, init);
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });
    const response = await dynamicFetch('https://cli-chat-proxy.grok.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'grok-4.5',
        tools: [
          {
            type: 'namespace',
            name: 'shell',
            tools: [
              {
                type: 'custom',
                name: 'apply_patch',
                format: { type: 'grammar', syntax: 'regex', definition: '.*' },
              },
            ],
          },
        ],
      }),
    });
    expect(hostCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(await captured?.json()).toEqual({
      model: 'grok-4.5',
      tools: [
        {
          type: 'namespace',
          name: 'shell',
          tools: [
            {
              type: 'function',
              name: 'apply_patch',
              parameters: {
                type: 'object',
                properties: { input: { type: 'string' } },
                required: ['input'],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    });
  });

  test('warns once per fetch without exposing grammar payloads', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async () => new Response(null, { status: 200 }),
      now: () => 0,
    });
    const body = JSON.stringify({
      model: 'grok-4.6',
      tools: [
        {
          type: 'custom',
          name: 'private-tool-name-marker',
          format: { type: 'grammar', syntax: 'regex', definition: 'first' },
        },
        {
          type: 'namespace',
          name: 'shell',
          tools: [
            {
              type: 'custom',
              name: 'apply_patch',
              format: {
                type: 'grammar',
                syntax: 'lark',
                definition: 'private-grammar-marker',
              },
            },
          ],
        },
      ],
    });

    try {
      await dynamicFetch('https://cli-chat-proxy.grok.com/v1/responses', { method: 'POST', body });
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenLastCalledWith(
        '[aio-proxy] xAI Grok Responses compatibility downgrade',
        'custom_tool.grammar',
        'function_fallback',
        'provider_lacks_native_grammar',
      );

      await dynamicFetch('https://cli-chat-proxy.grok.com/v1/responses', { method: 'POST', body });
      expect(warning).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-tool-name-marker');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-grammar-marker');
    } finally {
      warning.mockRestore();
    }
  });

  test('compiles custom tools without a format and emits no grammar warning', async () => {
    let captured: Request | undefined;
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });

    try {
      await dynamicFetch('https://cli-chat-proxy.grok.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'grok-4.6',
          tools: [{ type: 'custom', name: 'plain_custom' }],
        }),
      });

      expect(await captured?.json()).toEqual({
        model: 'grok-4.6',
        tools: [
          {
            type: 'function',
            name: 'plain_custom',
            parameters: {
              type: 'object',
              properties: { input: { type: 'string' } },
              required: ['input'],
              additionalProperties: false,
            },
          },
        ],
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test('forwards non-Responses request bodies unchanged', async () => {
    let captured: Request | undefined;
    const body = JSON.stringify({ tools: [{ type: 'function', name: 'automation_update', strict: true }] });
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });

    await dynamicFetch('https://cli-chat-proxy.grok.com/v1/chat/completions', { method: 'POST', body });

    expect(await captured?.text()).toBe(body);
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

function functionCallStream(name: string, argumentsText: string): Response {
  const response = {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'grok-4.6',
    output: [
      {
        id: 'fc_test',
        type: 'function_call',
        call_id: 'call_1',
        name,
        arguments: argumentsText,
        status: 'completed',
      },
    ],
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
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
    user: null,
    metadata: {},
  };
  const events = [
    { type: 'response.created', response: { id: response.id, created_at: response.created_at, model: response.model } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'fc_test', type: 'function_call', call_id: 'call_1', name, arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_test',
      output_index: 0,
      delta: argumentsText,
    },
    { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
    { type: 'response.completed', response },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
