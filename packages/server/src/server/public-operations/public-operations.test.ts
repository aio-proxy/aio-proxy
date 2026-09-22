import { describe, expect, test } from 'bun:test';

import {
  AnthropicMessageResponseSchema,
  AnthropicMessagesStreamEventSchema,
  formatAnthropicMessagesSSE,
  formatOpenAICompletionsSSE,
  formatOpenAIResponsesSSE,
  OpenAICompletionsResponseSchema,
  OpenAICompletionsStreamEventSchema,
  OpenAIResponsesResponseSchema,
  OpenAIResponsesStreamEventSchema,
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
  writeOpenAICompletionsResponse,
  writeOpenAICompletionsSSE,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from '@aio-proxy/core';

import { rewriteOpenAICompletionsRaw } from '../../../../core/src/protocol/openai-completions/completions-raw';
import { createRoutes } from '../create-routes';
import { PublicModelListSchema } from '../list-models/public-model-list';
import { publicOperations } from './index';

const partStream = (parts: readonly Record<string, unknown>[]) =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let body = '';
  for await (const chunk of stream) body += decoder.decode(chunk, { stream: true });
  return body + decoder.decode();
};

describe('documentation response schemas', () => {
  test('parse the list-models output shape', () => {
    expect(
      PublicModelListSchema.safeParse({
        object: 'list',
        data: [
          {
            capabilities: null,
            created: 0,
            created_at: '1970-01-01T00:00:00Z',
            display_name: 'gpt-test',
            id: 'gpt-test',
            max_input_tokens: null,
            max_tokens: null,
            object: 'model',
            owned_by: 'test-provider',
            type: 'model',
          },
        ],
        first_id: 'gpt-test',
        has_more: false,
        last_id: 'gpt-test',
      }).success,
    ).toBe(true);
  });

  test('parse JSON writer outputs with tool calls and absent usage', async () => {
    const chat = await writeOpenAICompletionsResponse(
      partStream([
        { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'call_1', delta: '{"city":"Paris"}' },
        { type: 'tool-input-end', id: 'call_1' },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
      ]) as never,
      { modelId: 'gpt-test' },
    );
    const responses = await writeOpenAIResponsesResponse(
      partStream([
        { type: 'text-delta', id: 'text_1', text: 'hello' },
        { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'call_1', delta: '{"city":"Paris"}' },
        { type: 'tool-input-end', id: 'call_1' },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
      ]) as never,
      { modelId: 'gpt-test' },
    );
    const messages = await writeAnthropicMessagesResponse(
      partStream([
        { type: 'tool-input-start', id: 'toolu_1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'toolu_1', delta: '{"city":"Paris"}' },
        { type: 'tool-input-end', id: 'toolu_1' },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: {} },
      ]) as never,
      { modelId: 'claude-test' },
    );

    expect(OpenAICompletionsResponseSchema.safeParse(chat).success).toBe(true);
    expect(chat).not.toContainKey('usage');
    expect(OpenAIResponsesResponseSchema.safeParse(responses).success).toBe(true);
    expect(responses).not.toContainKey('usage');
    expect(AnthropicMessageResponseSchema.safeParse(messages).success).toBe(true);
  });

  test('parse one event emitted by a streaming writer', async () => {
    const body = await collect(
      writeOpenAICompletionsSSE(partStream([{ type: 'text-delta', id: 'text_1', text: 'hello' }]) as never, {
        modelId: 'gpt-test',
      }),
    );
    const event = JSON.parse(body.split('\n')[0]!.slice('data: '.length)) as unknown;

    expect(OpenAICompletionsStreamEventSchema.safeParse(event).success).toBe(true);
    expect(formatOpenAICompletionsSSE([event])).toBe(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });

  test('formats documentation examples with each writer protocol terminal', async () => {
    const chatActual = await collect(writeOpenAICompletionsSSE(partStream([]) as never, { modelId: 'gpt-test' }));
    const responsesActual = await collect(writeOpenAIResponsesSSE(partStream([]) as never, { modelId: 'gpt-test' }));
    const messagesActual = await collect(
      writeAnthropicMessagesSSE(partStream([]) as never, { modelId: 'claude-test' }),
    );
    const lastFrame = (body: string) => body.trim().split('\n\n').at(-1)!;
    const eventName = (frame: string) => frame.split('\n')[0];

    expect(lastFrame(formatOpenAICompletionsSSE([]))).toBe(lastFrame(chatActual));
    expect(
      eventName(lastFrame(formatOpenAIResponsesSSE(OpenAIResponsesStreamEventSchema.meta()?.examples ?? []))),
    ).toBe(eventName(lastFrame(responsesActual)));
    expect(lastFrame(formatAnthropicMessagesSSE(AnthropicMessagesStreamEventSchema.meta()?.examples ?? []))).toBe(
      lastFrame(messagesActual),
    );
  });

  test('attaches valid non-empty examples to every descriptor schema instance', () => {
    const documented = publicOperations.filter((operation) => operation.classification === 'documented');
    for (const operation of documented) {
      const responseExamples = operation.responses.json.schema.meta()?.examples;
      expect(responseExamples).toBeArray();
      expect(responseExamples).not.toBeEmpty();
      for (const example of responseExamples ?? []) {
        expect(operation.responses.json.schema.safeParse(example).success).toBe(true);
      }
      if (operation.request !== undefined) {
        const requestExamples = operation.request.schema.meta()?.examples;
        expect(requestExamples).toBeArray();
        expect(requestExamples).not.toBeEmpty();
        for (const example of requestExamples ?? []) {
          expect(operation.request.schema.safeParse(example).success).toBe(true);
        }
        if (operation.responses.stream !== undefined) {
          expect(requestExamples).toContainEqual(expect.objectContaining({ stream: true }));
        }
      }
      if (operation.responses.stream !== undefined) {
        const streamExamples = operation.responses.stream.schema.meta()?.examples;
        expect(streamExamples).toBeArray();
        expect(streamExamples).not.toBeEmpty();
        for (const example of streamExamples ?? []) {
          expect(operation.responses.stream.schema.safeParse(example).success).toBe(true);
        }
      }
    }

    expect(
      documented.find((operation) => operation.operationId === 'createChatCompletion')?.responses.json.schema,
    ).toBe(OpenAICompletionsResponseSchema);
    expect(
      documented.find((operation) => operation.operationId === 'createChatCompletion')?.responses.stream?.schema,
    ).toBe(OpenAICompletionsStreamEventSchema);
    expect(documented.find((operation) => operation.operationId === 'createResponse')?.responses.json.schema).toBe(
      OpenAIResponsesResponseSchema,
    );
    expect(documented.find((operation) => operation.operationId === 'createResponse')?.responses.stream?.schema).toBe(
      OpenAIResponsesStreamEventSchema,
    );
    expect(documented.find((operation) => operation.operationId === 'createMessage')?.responses.json.schema).toBe(
      AnthropicMessageResponseSchema,
    );
    expect(documented.find((operation) => operation.operationId === 'createMessage')?.responses.stream?.schema).toBe(
      AnthropicMessagesStreamEventSchema,
    );
  });
});

test('classifies every route registered by the public server assembly', () => {
  const noop = () => undefined;
  const state = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'currentConfig'
          ? () => ({ server: { apiKeys: [], requireApiKey: false, password: undefined, logging: {} }, router: {} })
          : noop,
    },
  );
  const registeredKeys = [
    ...new Set(
      createRoutes(state as never)
        .routes.filter(
          ({ method, path }) =>
            ['DELETE', 'GET', 'POST'].includes(method) && (path.startsWith('/v1/') || path.startsWith('/v1beta/')),
        )
        .map(({ method, path }) => `${method} ${path}`),
    ),
  ].sort();
  const descriptorKeys = publicOperations.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort();
  const documented = publicOperations.filter((operation) => operation.classification === 'documented');

  expect(descriptorKeys).toEqual(registeredKeys);
  expect(documented.map(({ method, path, operationId, slug }) => ({ method, path, operationId, slug }))).toEqual([
    { method: 'get', path: '/v1/models', operationId: 'listModels', slug: 'list-models' },
    {
      method: 'post',
      path: '/v1/chat/completions',
      operationId: 'createChatCompletion',
      slug: 'chat-completions',
    },
    { method: 'post', path: '/v1/responses', operationId: 'createResponse', slug: 'responses' },
    { method: 'post', path: '/v1/messages', operationId: 'createMessage', slug: 'messages' },
  ]);
});

test('preserves unknown Chat Completions fields in a no-op raw rewrite', async () => {
  const body = '{"model":"gpt-test","messages":[{"role":"user","content":"hello"}],"future_field":42}';
  const rewritten = await rewriteOpenAICompletionsRaw(
    new Request('https://example.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    'gpt-test',
    new Set(),
  );

  expect(await rewritten.text()).toBe(body);
});
