import { describe, expect, test } from 'bun:test';

import { dereference, validate } from '@scalar/openapi-parser';
import { fromJSONSchema, z, type ZodType } from 'zod';

import { AnthropicMessagesRequestSchema, OpenAIResponsesRequestSchema } from '../../../packages/core/dist/index.js';
import {
  publicOperations,
  type DocumentedPublicOperation,
} from '../../../packages/server/src/server/public-operations';
import { projectOperation } from '../operation-document/index';
import { loadPublicOpenApi, operationSlugs } from './index';

const documentedOperation = (operationId: DocumentedPublicOperation['operationId']): DocumentedPublicOperation => {
  const operation = publicOperations.find(
    (candidate): candidate is DocumentedPublicOperation =>
      candidate.classification === 'documented' && candidate.operationId === operationId,
  );
  if (operation === undefined) throw new Error(`Missing test operation ${operationId}`);
  return operation;
};

const withExamples = async <T>(schema: ZodType, examples: readonly unknown[], run: () => Promise<T>): Promise<T> => {
  const metadata = schema.meta();
  z.globalRegistry.add(schema, { ...metadata, examples: [...examples] });
  try {
    return await run();
  } finally {
    if (metadata === undefined) z.globalRegistry.remove(schema);
    else z.globalRegistry.add(schema, metadata);
  }
};

const withField = async <T>(target: object, field: PropertyKey, value: unknown, run: () => Promise<T>): Promise<T> => {
  const existed = Object.hasOwn(target, field);
  const previous = Reflect.get(target, field);
  Reflect.set(target, field, value);
  try {
    return await run();
  } finally {
    if (existed) Reflect.set(target, field, previous);
    else Reflect.deleteProperty(target, field);
  }
};

const operationSchema = async (operationId: string) => {
  const document = await loadPublicOpenApi();
  const operation = projectOperation(document, operationId);
  const pathItem = Object.values(operation.paths)[0]! as Record<string, unknown>;
  const method = Object.values(pathItem).find(
    (value) => typeof value === 'object' && value !== null && 'operationId' in value,
  ) as {
    requestBody: { content: { 'application/json': { schema: Record<string, unknown> } } };
  };
  return method.requestBody.content['application/json'].schema;
};

describe('loadPublicOpenApi', () => {
  test('builds the four operations from implementation schemas', async () => {
    const document = await loadPublicOpenApi();
    expect(operationSlugs(document)).toEqual(['list-models', 'chat-completions', 'responses', 'messages']);
    const chat = projectOperation(document, 'createChatCompletion');
    expect(chat.paths['/v1/chat/completions']?.post?.responses?.['200']?.content).toContainKeys([
      'application/json',
      'text/event-stream',
    ]);
    expect(
      chat.paths['/v1/chat/completions']?.post?.requestBody?.content['application/json']?.schema.additionalProperties,
    ).not.toBe(false);
    expect(
      chat.paths['/v1/chat/completions']?.post?.requestBody?.content['application/json']?.schema.properties?.metadata
        ?.additionalProperties,
    ).toEqual({});
    expect(
      projectOperation(document, 'createMessage').paths['/v1/messages']?.post?.responses?.['200']?.content,
    ).toContainKey('text/event-stream');
  });

  test('emits request schemas that reject the same hidden wire constraints as runtime parsing', async () => {
    const invalidResponses = {
      model: 'gpt-test',
      input: [{ role: 'user', content: [{ type: 'input_image' }] }],
    };
    const invalidToolResult = {
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'missing id' }] }],
    };
    const invalidThinking = {
      model: 'claude-test',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'private',
              signature: 'signature',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    };
    const responsesSchema = fromJSONSchema(await operationSchema('createResponse'));
    const messagesSchema = fromJSONSchema(await operationSchema('createMessage'));

    expect(OpenAIResponsesRequestSchema.safeParse(invalidResponses).success).toBe(false);
    expect(responsesSchema.safeParse(invalidResponses).success).toBe(false);
    expect(AnthropicMessagesRequestSchema.safeParse(invalidToolResult).success).toBe(false);
    expect(messagesSchema.safeParse(invalidToolResult).success).toBe(false);
    expect(AnthropicMessagesRequestSchema.safeParse(invalidThinking).success).toBe(false);
    expect(messagesSchema.safeParse(invalidThinking).success).toBe(false);
  });

  test('matches runtime validation at Anthropic image base64 and URL boundaries', async () => {
    const messagesSchema = fromJSONSchema(await operationSchema('createMessage'));
    const request = (source: Record<string, unknown>) => ({
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'image', source }] }],
    });
    const cases = [
      { source: { type: 'base64', media_type: 'image/png', data: '' }, accepted: false },
      { source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, accepted: true },
      { source: { type: 'url', url: 'http://%' }, accepted: false },
      { source: { type: 'url', url: 'HTTPS://example.com/a.png' }, accepted: true },
    ] as const;

    for (const { source, accepted } of cases) {
      expect(AnthropicMessagesRequestSchema.safeParse(request(source)).success).toBe(accepted);
      expect(messagesSchema.safeParse(request(source)).success).toBe(accepted);
    }
  });

  test('represents an absent Anthropic function-tool type as impossible when present', async () => {
    const schema = fromJSONSchema(await operationSchema('createMessage'));
    const base = {
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    };

    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, tools: [{ ...base.tools[0], type: 'function' }] }).success).toBe(false);
  });

  test('rejects missing descriptor examples before schema conversion', async () => {
    const requestSchema = documentedOperation('createChatCompletion').request!.schema;

    await withExamples(requestSchema, [], async () => {
      await expect(loadPublicOpenApi()).rejects.toThrow('Missing examples for createChatCompletion request');
    });
  });

  test('requires a valid stream true request example for streaming operations', async () => {
    const requestSchema = documentedOperation('createChatCompletion').request!.schema;

    await withExamples(
      requestSchema,
      [{ model: 'gpt-5', messages: [{ role: 'user', content: 'Hello.' }] }],
      async () => {
        await expect(loadPublicOpenApi()).rejects.toThrow(
          'Missing stream: true request example for createChatCompletion',
        );
      },
    );
  });

  test('rejects an invalid descriptor example before schema conversion', async () => {
    const responseSchema = documentedOperation('createResponse').responses.json.schema;

    await withExamples(responseSchema, [{}], async () => {
      await expect(loadPublicOpenApi()).rejects.toThrow('Invalid example for createResponse application/json response');
    });
  });

  test('emits protocol-correct HTTP stream examples and explains stream opt-in', async () => {
    const document = await loadPublicOpenApi();
    const chat = projectOperation(document, 'createChatCompletion').paths['/v1/chat/completions']?.post;
    const responses = projectOperation(document, 'createResponse').paths['/v1/responses']?.post;
    const messages = projectOperation(document, 'createMessage').paths['/v1/messages']?.post;
    const streamExample = (operation: typeof chat): string => {
      const media = operation?.responses?.['200']?.content?.['text/event-stream'] as { example?: unknown } | undefined;
      if (typeof media?.example !== 'string') throw new Error('Missing HTTP stream example');
      return media.example;
    };

    expect(chat?.description).toContain('`stream: true`');
    expect(responses?.description).toContain('`stream: true`');
    expect(messages?.description).toContain('`stream: true`');

    expect(streamExample(chat)).toStartWith('data: {');
    expect(streamExample(chat)).toEndWith('data: [DONE]\n\n');

    expect(streamExample(responses)).toContain('event: response.output_text.delta\ndata: {');
    expect(streamExample(responses).trim().split('\n\n').at(-1)).toStartWith(
      'event: response.completed\ndata: {"type":"response.completed"',
    );
    expect(streamExample(responses)).not.toContain('[DONE]');

    expect(streamExample(messages)).toContain('event: content_block_delta\ndata: {');
    expect(streamExample(messages)).toEndWith('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(streamExample(messages)).not.toContain('[DONE]');
  });

  test('rejects duplicate documented operation IDs before path assembly', async () => {
    const responses = documentedOperation('createResponse');

    await withField(responses, 'operationId', 'createChatCompletion', async () => {
      await expect(loadPublicOpenApi()).rejects.toThrow('Duplicate operationId "createChatCompletion"');
    });
  });

  test('rejects duplicate or missing documented slugs before path assembly', async () => {
    const responses = documentedOperation('createResponse');

    await withField(responses, 'slug', 'chat-completions', async () => {
      await expect(loadPublicOpenApi()).rejects.toThrow('Duplicate operation slug "chat-completions"');
    });
    await withField(responses, 'slug', undefined, async () => {
      await expect(loadPublicOpenApi()).rejects.toThrow('Missing slug for createResponse');
    });
  });

  test('rejects duplicate method and path identities before path assembly', async () => {
    const responses = documentedOperation('createResponse');

    await withField(responses, 'path', '/v1/chat/completions', async () => {
      await expect(loadPublicOpenApi()).rejects.toThrow('Duplicate public route "POST /v1/chat/completions"');
    });
  });

  test('preserves distinct HTTP methods that share one path', async () => {
    const models = documentedOperation('listModels');

    await withField(models, 'path', '/v1/chat/completions', async () => {
      const document = await loadPublicOpenApi();
      expect(document.paths['/v1/chat/completions']).toContainKeys(['get', 'post']);
      expect(() => projectOperation(document, 'listModels')).not.toThrow();
      expect(() => projectOperation(document, 'createChatCompletion')).not.toThrow();
    });
  });

  test('validates, dereferences, projects, and serializes the generated document independently', async () => {
    const document = await loadPublicOpenApi();
    const validated = await validate(document);
    const dereferenced = dereference(document);

    expect(validated.valid).toBe(true);
    expect(dereferenced.errors).toEqual([]);
    expect(dereferenced.specification).toBeDefined();
    for (const operationId of ['listModels', 'createChatCompletion', 'createResponse', 'createMessage']) {
      expect((await validate(projectOperation(document, operationId))).valid).toBe(true);
    }
    expect(() => JSON.parse(JSON.stringify(document))).not.toThrow();
  });
});
