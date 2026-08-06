import { describe, expect, spyOn, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { openAIResponsesAdapter, writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from '../index';

describe('openAIResponsesAdapter', () => {
  test('defaults to non-stream and exposes routing, tools, and current writers', async () => {
    const raw = new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'alias',
        input: 'hello',
        tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }],
        reasoning: { effort: 'high' },
      }),
    });

    const parsed = await openAIResponsesAdapter.parse(raw, {});

    expect(openAIResponsesAdapter.model(parsed, {})).toBe('alias');
    expect(openAIResponsesAdapter.variant(parsed, {})).toBe('high');
    expect(openAIResponsesAdapter.wantsStream(parsed, {})).toBe(false);
    const invocation = openAIResponsesAdapter.modelInvocation(parsed, {});
    expect(Object.keys(invocation.tools ?? {})).toEqual(['weather']);
    expect(invocation.settings).toEqual({
      providerOptions: { openai: { store: false } },
      reasoning: 'high',
    });
    expect(
      await (await openAIResponsesAdapter.rawRequest(raw, parsed, 'upstream', new Set(), {})).json(),
    ).toMatchObject({
      model: 'upstream',
    });
    expect(openAIResponsesAdapter.modelJson).toBe(writeOpenAIResponsesResponse);
    expect(openAIResponsesAdapter.modelSse).toBe(writeOpenAIResponsesSSE);
  });

  test('routes an unknown effort as a variant but omits it from AI SDK settings', async () => {
    const raw = new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', input: 'hi', reasoning: { effort: 'ultra' } }),
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});

    // Ingress keeps the raw level so raw passthrough and routing can use it,
    // but the AI SDK call drops a level it does not know and defers to the
    // provider default instead of forwarding an invalid enum.
    expect(openAIResponsesAdapter.variant(parsed, {})).toBe('ultra');
    const invocation = openAIResponsesAdapter.modelInvocation(parsed, {});
    expect('reasoning' in invocation.settings).toBe(false);
  });

  test('keeps custom tools portable outside the OpenAI Responses target', async () => {
    const base = await customInvocation();
    const portableMessage = base.messages[0];
    const portableTool = base.tools?.emit_raw;

    expect(base.messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'emit_raw', input: { input: 'pwd' } }],
    });
    expect(portableTool).toMatchObject({ type: 'function' });
    expect(openAIResponsesAdapter.modelInvocationForTarget(base, ProviderProtocol.Anthropic, new Set())).toBe(base);

    const specialized = openAIResponsesAdapter.modelInvocationForTarget(
      base,
      ProviderProtocol.OpenAIResponse,
      new Set(),
    );

    expect(specialized).not.toBe(base);
    expect(specialized.messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'emit_raw', input: 'pwd' }],
    });
    expect(base.messages[0]).toBe(portableMessage);
    expect(base.tools?.emit_raw).toBe(portableTool);
  });

  test('leaves noncanonical custom input portable during target materialization', async () => {
    const base = await customInvocation();
    const assistant = base.messages[0];
    if (assistant?.role !== 'assistant' || typeof assistant.content === 'string') {
      throw new TypeError('Expected custom tool-call history');
    }
    const malformed = {
      ...base,
      messages: [
        {
          ...assistant,
          content: assistant.content.map((part) =>
            part.type === 'tool-call' ? { ...part, input: { input: 42 } } : part,
          ),
        },
        ...base.messages.slice(1),
      ],
    };

    const specialized = openAIResponsesAdapter.modelInvocationForTarget(
      malformed,
      ProviderProtocol.OpenAIResponse,
      new Set(),
    );

    expect(specialized.messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', input: { input: 42 } }],
    });
  });

  test('drops only OpenAI image detail when materializing an ordinary image for Anthropic', async () => {
    const base = await userImageInvocation();
    const message = base.messages[0];
    if (message?.role !== 'user' || typeof message.content === 'string') {
      throw new TypeError('Expected user image history');
    }
    const image = message.content[0];
    if (image?.type !== 'file') throw new TypeError('Expected user image file part');
    const openaiOptions = image.providerOptions?.['openai'];
    if (typeof openaiOptions !== 'object' || openaiOptions === null || Array.isArray(openaiOptions)) {
      throw new TypeError('Expected OpenAI image options');
    }
    const withSentinels: typeof base = {
      ...base,
      messages: [
        {
          ...message,
          content: [
            {
              ...image,
              providerOptions: {
                ...image.providerOptions,
                openai: { ...openaiOptions, retained: 'sentinel' },
                custom: { retained: true },
              },
            },
          ],
        },
      ],
    };
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const portable = openAIResponsesAdapter.modelInvocationForTarget(
        withSentinels,
        ProviderProtocol.Anthropic,
        new Set(),
      );

      expect(portable.messages[0]).toEqual({
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: 'AA==' },
            providerOptions: {
              openai: { retained: 'sentinel' },
              custom: { retained: true },
            },
          },
        ],
      });
      expect(withSentinels.messages[0]).toMatchObject({
        content: [{ providerOptions: { openai: { imageDetail: 'high', retained: 'sentinel' } } }],
      });
      expect(warn).toHaveBeenCalledWith(
        '[aio-proxy] OpenAI Responses model conversion degraded',
        'image_detail',
        'messages.0.content.0.providerOptions.openai.imageDetail',
        'dropped',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('drops OpenAI image detail inside tool results for Anthropic', async () => {
    const base = await toolImageInvocation();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const portable = openAIResponsesAdapter.modelInvocationForTarget(base, ProviderProtocol.Anthropic, new Set());
      const message = portable.messages[1];
      if (message?.role !== 'tool') throw new TypeError('Expected tool image history');
      const result = message.content[0];
      if (result?.type !== 'tool-result' || result.output.type !== 'content') {
        throw new TypeError('Expected tool image result');
      }

      expect(result.output.value[0]).toEqual({
        type: 'file',
        mediaType: 'image/png',
        data: { type: 'data', data: 'AA==' },
        providerOptions: {
          openai: {},
          aioProxy: { toolImage: true, trust: expect.any(String) },
        },
      });
      expect(base.messages[1]).toMatchObject({
        content: [
          {
            output: {
              value: [{ providerOptions: { openai: { imageDetail: 'high' } } }],
            },
          },
        ],
      });
      expect(warn).toHaveBeenCalledWith(
        '[aio-proxy] OpenAI Responses model conversion degraded',
        'image_detail',
        'messages.1.content.0.output.value.0.providerOptions.openai.imageDetail',
        'dropped',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('preserves OpenAI image detail for the Responses target', async () => {
    const base = await userImageInvocation();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const specialized = openAIResponsesAdapter.modelInvocationForTarget(
        base,
        ProviderProtocol.OpenAIResponse,
        new Set(),
      );

      expect(specialized.messages[0]).toMatchObject({
        content: [{ providerOptions: { openai: { imageDetail: 'high' } } }],
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('normalizes an uncompressed raw request when the resolved model is unchanged', async () => {
    const body = '{"model":"same", "input":"hello", "beta_field":true}';
    const raw = new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: {
        'content-length': String(new TextEncoder().encode(body).byteLength),
        'content-type': 'application/json',
        'x-sentinel': 'preserved',
      },
      body,
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});

    const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'same', new Set(), {});

    expect(forwarded).not.toBe(raw);
    expect(forwarded.headers.get('content-encoding')).toBeNull();
    expect(forwarded.headers.get('x-sentinel')).toBe('preserved');
    expect(await forwarded.json()).toEqual({ model: 'same', input: 'hello', beta_field: true });
  });

  test('normalizes a compressed same-model request before raw forwarding', async () => {
    const body = Bun.zstdCompressSync(
      new TextEncoder().encode(JSON.stringify({ model: 'same', input: 'hello', beta_field: true })),
    );
    const raw = new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: {
        'content-encoding': 'zstd',
        'content-length': String(body.byteLength),
        'content-type': 'application/json',
        'x-sentinel': 'preserved',
      },
      body,
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});

    const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, 'same', new Set(), {});

    expect(forwarded.headers.get('content-encoding')).toBeNull();
    expect(forwarded.headers.get('content-length')).toBeNull();
    expect(forwarded.headers.get('x-sentinel')).toBe('preserved');
    expect(await forwarded.json()).toEqual({ model: 'same', input: 'hello', beta_field: true });
  });

  test('clamps reasoning.effort in the raw body against the supported set', async () => {
    const body = { model: 'src', input: 'hi', reasoning: { effort: 'xhigh' } };
    const raw = new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = await openAIResponsesAdapter.parse(raw, {});

    const forwarded = await openAIResponsesAdapter.rawRequest(
      raw,
      parsed,
      'upstream',
      new Set(['low', 'medium', 'high']),
      {},
    );

    expect(await forwarded.json()).toMatchObject({ model: 'upstream', reasoning: { effort: 'high' } });
  });
});

async function customInvocation() {
  const parsed = await openAIResponsesAdapter.parse(
    new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'alias',
        input: [
          { type: 'custom_tool_call', call_id: 'call_1', name: 'emit_raw', input: 'pwd' },
          { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' },
        ],
        tools: [{ type: 'custom', name: 'emit_raw' }],
      }),
    }),
    {},
  );
  return openAIResponsesAdapter.modelInvocation(parsed, {});
}

async function userImageInvocation() {
  const parsed = await openAIResponsesAdapter.parse(
    new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'alias',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' }],
          },
        ],
      }),
    }),
    {},
  );
  return openAIResponsesAdapter.modelInvocation(parsed, {});
}

async function toolImageInvocation() {
  const parsed = await openAIResponsesAdapter.parse(
    new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'alias',
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' }],
          },
        ],
      }),
    }),
    {},
  );
  return openAIResponsesAdapter.modelInvocation(parsed, {});
}
