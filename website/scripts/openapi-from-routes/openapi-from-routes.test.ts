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
  test('builds all documented operations from implementation schemas', async () => {
    const document = await loadPublicOpenApi();
    expect(operationSlugs(document)).toEqual(
      publicOperations
        .filter((operation) => operation.classification === 'documented')
        .sort((left, right) => left.navOrder - right.navOrder)
        .map((operation) => operation.slug),
    );
    const chat = projectOperation(document, 'createChatCompletion');
    expect(chat.paths['/v1/chat/completions']?.post?.responses?.['2XX']?.content).toContainKeys([
      'application/json',
      'text/event-stream',
    ]);
    expect(chat.paths['/v1/chat/completions']?.post?.responses?.['200']).toBeUndefined();
    expect(
      chat.paths['/v1/chat/completions']?.post?.requestBody?.content['application/json']?.schema.additionalProperties,
    ).not.toBe(false);
    expect(
      chat.paths['/v1/chat/completions']?.post?.requestBody?.content['application/json']?.schema.properties?.metadata
        ?.additionalProperties,
    ).toEqual({});
    expect(
      projectOperation(document, 'createMessage').paths['/v1/messages']?.post?.responses?.['2XX']?.content,
    ).toContainKey('text/event-stream');
  });

  test('documents both anonymous and bearer-authenticated deployments', async () => {
    const document = await loadPublicOpenApi();
    const security = projectOperation(document, 'createChatCompletion').security;

    expect(security).toContainEqual({});
    expect(security).toContainEqual({ bearerAuth: [] });
    expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
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

  test("preserves each streaming request descriptor's exact examples in the projected document", async () => {
    for (const operationId of ['createChatCompletion', 'createResponse', 'createMessage'] as const) {
      const operation = documentedOperation(operationId);
      const examples = operation.request?.schema.meta()?.examples;
      const schema = await operationSchema(operationId);

      expect(schema.examples).toEqual(examples);
      expect(schema.examples).toContainEqual(expect.objectContaining({ stream: true }));
    }
  });

  test('rejects an invalid descriptor example before schema conversion', async () => {
    const responseSchema = documentedOperation('createResponse').responses.json!.schema;

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
      const media = operation?.responses?.['2XX']?.content?.['text/event-stream'] as { example?: unknown } | undefined;
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
test('publishes binary, multipart, parameterized and WebSocket operations without inventing JSON responses', async () => {
  const document = await loadPublicOpenApi();
  const paths = document.paths;
  expect(
    paths['/v1/audio/transcriptions']?.post?.requestBody?.content['multipart/form-data']?.schema.properties?.file
      ?.format,
  ).toBe('binary');
  expect(paths['/v1/audio/speech']?.post?.responses['2XX']?.content).toHaveProperty('audio/mpeg');
  expect(paths['/v1/videos/{video_id}']?.get?.parameters).toContainEqual(
    expect.objectContaining({ name: 'video_id', in: 'path', required: true }),
  );
  expect(paths['/v1/videos/{video_id}']?.delete).toBeDefined();
  expect(paths['/v1/realtime']?.get?.responses['101']).toBeDefined();
  expect(paths['/v1/realtime']?.get?.responses['200']).toBeUndefined();
  expect(paths['/v1/realtime/calls/{call_id}/hangup']?.post?.responses['204']?.content).toBeUndefined();
  for (const action of [
    'generateContent',
    'streamGenerateContent',
    'countTokens',
    'embedContent',
    'batchEmbedContents',
  ]) {
    expect(paths[`/v1beta/models/{model}:${action}`]?.post).toBeDefined();
  }
});

test('documents speech binary media types returned by conversion and raw passthrough', async () => {
  const content = (await loadPublicOpenApi()).paths['/v1/audio/speech']?.post?.responses['2XX']?.content;
  expect(content).toContainKeys([
    'audio/mpeg',
    'audio/wav',
    'audio/opus',
    'audio/flac',
    'audio/aac',
    'audio/pcm',
    'audio/*',
    'application/octet-stream',
  ]);
});

test('documents subtitle and provider-defined raw transcription responses', async () => {
  const paths = (await loadPublicOpenApi()).paths;
  for (const action of ['transcriptions', 'translations']) {
    const content = paths[`/v1/audio/${action}`]?.post?.responses['2XX']?.content;
    expect(content).toContainKeys(['application/json', 'text/plain', 'text/vtt', 'application/x-subrip', '*/*']);
    expect(content?.['*/*']?.schema.format).toBe('binary');
  }
});

test('rejects blank video prompts in every documented request representation', async () => {
  const paths = (await loadPublicOpenApi()).paths;
  const requests = [
    ['/v1/videos', 'application/json', { model: 'sora-2' }],
    ['/v1/videos', 'multipart/form-data', { model: 'sora-2' }],
    ['/v1/videos/edits', 'application/json', { video: { id: 'video_1' } }],
    ['/v1/videos/extensions', 'application/json', { video: { id: 'video_1' } }],
    ['/v1/videos/{video_id}/remix', 'application/json', {}],
  ] as const;
  for (const [path, contentType, fields] of requests) {
    const schema = paths[path]?.post?.requestBody?.content[contentType]?.schema;
    expect(schema).toBeDefined();
    const request = fromJSONSchema(schema!);
    expect(request.safeParse({ ...fields, prompt: 'A moving landscape.' }).success).toBe(true);
    for (const prompt of ['', ' \t\n']) {
      expect(request.safeParse({ ...fields, prompt }).success).toBe(false);
    }
  }
});

test('requires a nonempty binary file in both audio multipart operations', async () => {
  const paths = (await loadPublicOpenApi()).paths;
  for (const action of ['transcriptions', 'translations']) {
    const file =
      paths[`/v1/audio/${action}`]?.post?.requestBody?.content['multipart/form-data']?.schema.properties?.file;
    expect(file?.format).toBe('binary');
    expect(file?.minLength).toBe(1);
  }
});

test('documents the optional provider-defined body of a successful video deletion', async () => {
  const response = (await loadPublicOpenApi()).paths['/v1/videos/{video_id}']?.delete?.responses['2XX'];
  expect(response?.description).toContain('body');
  expect(response?.content?.['*/*']?.schema.format).toBe('binary');
});

test('allows provider extensions throughout chat completion response schemas', async () => {
  const responses = (await loadPublicOpenApi()).paths['/v1/chat/completions']?.post?.responses['2XX']?.content;
  expect(responses?.['application/json']?.schema).toMatchObject({
    additionalProperties: {},
    properties: {
      choices: {
        items: {
          additionalProperties: {},
          properties: {
            message: {
              additionalProperties: {},
              properties: {
                tool_calls: {
                  items: { additionalProperties: {}, properties: { function: { additionalProperties: {} } } },
                },
              },
            },
          },
        },
      },
    },
  });
  expect(responses?.['text/event-stream']?.schema).toMatchObject({
    additionalProperties: {},
    properties: { choices: { items: { additionalProperties: {} } } },
  });
});

test('documents raw Responses tool items and incomplete lifecycle statuses', async () => {
  const schema = (await loadPublicOpenApi()).paths['/v1/responses']?.post?.responses['2XX']?.content?.[
    'application/json'
  ]?.schema;
  expect(schema).toBeDefined();
  const response = fromJSONSchema(schema!);
  const base = {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'gpt-test',
    output_text: '',
    output: [{ id: 'ws_1', type: 'web_search_call', status: 'completed' }],
  };

  for (const status of ['incomplete', 'queued', 'cancelled']) {
    expect(response.safeParse({ ...base, status }).success).toBe(true);
  }
  expect(
    response.safeParse({ ...base, status: 'completed', output: [{ id: 'p_1', type: 'provider_tool_result' }] }).success,
  ).toBe(true);
});

test('documents sparse raw Responses JSON and SSE envelopes', async () => {
  const content = (await loadPublicOpenApi()).paths['/v1/responses']?.post?.responses['2XX']?.content;
  expect(content).toBeDefined();
  const response = fromJSONSchema(content!['application/json']!.schema);
  const event = fromJSONSchema(content!['text/event-stream']!.schema);
  expect(response.safeParse({ id: 'resp_raw', status: 'completed' }).success).toBe(true);
  expect(response.safeParse({ status: 'completed' }).success).toBe(true);
  expect(
    event.safeParse({ type: 'response.completed', response: { id: 'resp_raw', status: 'completed' } }).success,
  ).toBe(true);
});

test('documents server-tool blocks in raw Anthropic responses', async () => {
  const schema = (await loadPublicOpenApi()).paths['/v1/messages']?.post?.responses['2XX']?.content?.[
    'application/json'
  ]?.schema;
  expect(schema).toBeDefined();
  const response = fromJSONSchema(schema!);
  const raw = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'server_tool_use', id: 'srvtool_1', name: 'web_search', input: { query: 'weather' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtool_1', content: [] },
    ],
    model: 'claude-test',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  expect(response.safeParse(raw).success).toBe(true);
  expect(response.safeParse({ fallback: true }).success).toBe(true);
});

test('documents raw chat completions without created or model fields', async () => {
  const schema = (await loadPublicOpenApi()).paths['/v1/chat/completions']?.post?.responses['2XX']?.content?.[
    'application/json'
  ]?.schema;
  expect(schema).toBeDefined();
  const response = fromJSONSchema(schema!);

  expect(response.safeParse({ id: 'chatcmpl-upstream', object: 'chat.completion', choices: [] }).success).toBe(true);
});

test('rejects invalid realtime call IDs in documented path and query parameters', async () => {
  const paths = (await loadPublicOpenApi()).paths;
  const parameters = [
    paths['/v1/realtime/calls/{call_id}/hangup']?.post?.parameters?.[0],
    paths['/v1/live/{call_id}']?.get?.parameters?.[0],
    paths['/v1/realtime']?.get?.parameters?.find((parameter) => parameter.name === 'call_id'),
  ];
  for (const parameter of parameters) {
    const pattern = parameter?.schema?.pattern;
    expect(pattern).toBeString();
    const callId = new RegExp(pattern!);
    expect(callId.test('call_1-A')).toBe(true);
    for (const invalid of ['', 'bad/id', 'a'.repeat(129)]) expect(callId.test(invalid)).toBe(false);
  }
});

test('accepts padded realtime model IDs whose trimmed value is within the runtime limit', async () => {
  const document = await loadPublicOpenApi();
  const padded = `${' '.repeat(3)}${'m'.repeat(128)}${' '.repeat(3)}`;
  const tooLong = `${' '.repeat(3)}${'m'.repeat(129)}${' '.repeat(3)}`;
  const directModel = document.paths['/v1/realtime']?.get?.parameters?.find((parameter) => parameter.name === 'model');
  expect(fromJSONSchema(directModel!.schema).safeParse(padded).success).toBe(true);
  expect(fromJSONSchema(directModel!.schema).safeParse(tooLong).success).toBe(false);

  const json = document.paths['/v1/realtime']?.post?.requestBody?.content['application/json']?.schema;
  expect(fromJSONSchema(json!).safeParse({ model: padded }).success).toBe(true);
  expect(fromJSONSchema(json!).safeParse({ model: tooLong }).success).toBe(false);

  const contentSchema =
    document.paths['/v1/realtime']?.post?.requestBody?.content['multipart/form-data']?.schema.properties?.session
      ?.contentSchema;
  expect(fromJSONSchema(contentSchema!).safeParse({ model: padded }).success).toBe(true);
  expect(fromJSONSchema(contentSchema!).safeParse({ model: tooLong }).success).toBe(false);
});

test('caps the documented direct realtime model query at the runtime limit', async () => {
  const parameters = (await loadPublicOpenApi()).paths['/v1/realtime']?.get?.parameters;
  const model = parameters?.find((parameter) => parameter.name === 'model');
  expect(model?.schema).toBeDefined();
  const schema = fromJSONSchema(model!.schema);

  expect(schema.safeParse('m'.repeat(128)).success).toBe(true);
  expect(schema.safeParse('m'.repeat(129)).success).toBe(false);
});

test('documents bounded realtime create models in JSON and multipart sessions', async () => {
  const paths = (await loadPublicOpenApi()).paths;
  for (const path of ['/v1/live', '/v1/realtime', '/v1/realtime/calls']) {
    const content = paths[path]?.post?.requestBody?.content;
    const json = content?.['application/json']?.schema;
    expect(json?.properties?.model?.pattern).toBe('^\\s*(?:[\\s\\S]{1,128})?\\s*$');
    expect(json?.properties?.session?.properties?.model?.pattern).toBe('^\\s*(?:[\\s\\S]{1,128})?\\s*$');
    const session = content?.['multipart/form-data']?.schema.properties?.session;
    expect(session?.contentMediaType).toBe('application/json');
    expect(session?.contentSchema?.properties?.model?.pattern).toBe('^\\s*(?:[\\s\\S]{1,128})?\\s*$');
  }
});

test('keeps Gemini URL models out of required bodies and rejects unsupported embedding configuration', async () => {
  const generation = fromJSONSchema(await operationSchema('generateContent'));
  expect(generation.safeParse({ contents: [{ parts: [{ text: 'Hello.' }] }] }).success).toBe(true);
  expect(generation.safeParse({ contents: [{ parts: [{}] }] }).success).toBe(false);
  expect(
    generation.safeParse({ contents: [{ parts: [{ text: 'Hello.', functionCall: { name: 'lookup' } }] }] }).success,
  ).toBe(false);
  const document = await loadPublicOpenApi();
  const modelParameter = document.paths['/v1beta/models/{model}:generateContent']?.post?.parameters?.[0];
  expect(fromJSONSchema(modelParameter!.schema).safeParse('').success).toBe(false);
  expect(fromJSONSchema(modelParameter!.schema).safeParse('gemini-2.5-flash').success).toBe(true);
  const schema =
    document.paths['/v1beta/models/{model}:embedContent']?.post?.requestBody?.content['application/json']?.schema;
  expect(schema?.properties?.embedContentConfig?.properties?.audioTrackExtraction).toEqual({ not: {} });
  expect(schema?.properties?.embedContentConfig?.properties?.documentOcr).toEqual({ not: {} });
  expect(schema?.properties?.content?.properties?.parts?.contains).toEqual({
    properties: { text: { type: 'string', minLength: 1 } },
    required: ['text'],
  });
});

test('projects the Gemini interactions routing XOR and nonblank constraint', async () => {
  const schema = fromJSONSchema(await operationSchema('createInteraction'));
  expect(schema.safeParse({ model: 'gemini-2.5-flash', input: 'Hello.' }).success).toBe(true);
  expect(schema.safeParse({ agent: 'deep-research', input: 'Hello.' }).success).toBe(true);
  for (const invalid of [
    { input: 'Hello.' },
    { model: 'gemini-2.5-flash', agent: 'deep-research', input: 'Hello.' },
    { model: '   ', input: 'Hello.' },
    { agent: '\t', input: 'Hello.' },
  ]) {
    expect(schema.safeParse(invalid).success).toBe(false);
  }
});

test('projects image count limits for generation and edit request schemas', async () => {
  const document = await loadPublicOpenApi();
  for (const operationId of ['generateImages', 'editImages']) {
    const operation = Object.values(document.paths)
      .flatMap((item) => Object.values(item as Record<string, unknown>))
      .find((candidate) => (candidate as { operationId?: string }).operationId === operationId) as {
      requestBody?: { content?: { 'application/json'?: { schema?: Record<string, any> } } };
    };
    const schema = operation.requestBody?.content?.['application/json']?.schema;
    const count = schema?.allOf?.[0];
    expect(count?.if?.properties?.model?.pattern).toBe('^\\s*(?:[^/\\s]+/)?dall-e-3\\s*$');
    const general = fromJSONSchema({ type: 'object', properties: { n: count?.else?.properties?.n } });
    const dallE3 = fromJSONSchema({ type: 'object', properties: { n: count?.then?.properties?.n } });
    for (const n of [0, 11]) expect(general.safeParse({ n }).success).toBe(false);
    expect(general.safeParse({ n: 10 }).success).toBe(true);
    expect(dallE3.safeParse({ n: 2 }).success).toBe(false);
    expect(dallE3.safeParse({ n: 1 }).success).toBe(true);
  }
});

test('projects Gemini inline-data and file-URI validation on every media operation', async () => {
  const operationIds = ['generateContent', 'streamGenerateContent', 'countContentTokens'] as const;
  for (const operationId of operationIds) {
    const schema = fromJSONSchema(await operationSchema(operationId));
    const inline = {
      contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: '%%%%' } }] }],
    };
    const file = {
      contents: [{ parts: [{ fileData: { mimeType: 'image/png', fileUri: 'ftp://example.com/image.png' } }] }],
    };
    const wrongFileMime = {
      contents: [{ parts: [{ fileData: { mimeType: 'text/plain', fileUri: 'https://example.com/image.txt' } }] }],
    };
    const responseMedia = {
      contents: [
        {
          parts: [
            {
              functionResponse: {
                name: 'lookup',
                response: {},
                parts: [{ inlineData: { mimeType: 'text/plain', data: 'AAAA' } }],
              },
            },
          ],
        },
      ],
    };
    const validResponseMedia = structuredClone(responseMedia);
    validResponseMedia.contents[0]!.parts[0]!.functionResponse!.parts![0]!.inlineData.mimeType = 'image/png';
    const valid = {
      contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }],
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(inline).success).toBe(false);
    expect(schema.safeParse(file).success).toBe(false);
    expect(schema.safeParse(wrongFileMime).success).toBe(false);
    expect(schema.safeParse(responseMedia).success).toBe(false);
    expect(schema.safeParse(validResponseMedia).success).toBe(true);
  }

  const mediaSchema = (await loadPublicOpenApi()).paths['/v1beta/models/{model}:generateContent']?.post?.requestBody
    ?.content['application/json']?.schema;
  const dataSchema = mediaSchema?.properties?.contents?.items?.properties?.parts?.items?.oneOf?.find(
    (variant) => variant.properties?.inlineData !== undefined,
  )?.properties?.inlineData?.properties?.data;
  expect(dataSchema?.anyOf).toEqual([
    expect.objectContaining({ maxLength: 27_962_024 }),
    expect.objectContaining({ maxLength: 27_962_028, pattern: expect.stringContaining('==') }),
    expect.objectContaining({ maxLength: 27_962_028, pattern: expect.stringContaining('=') }),
  ]);
});

test('preserves raw-only OpenAI Responses request variants', async () => {
  const schema = fromJSONSchema(await operationSchema('createResponse'));
  expect(schema.safeParse({ model: 'gpt-test', input: [{ type: 'computer_call', id: 'computer_1' }] }).success).toBe(
    true,
  );
  expect(schema.safeParse({ model: 'gpt-test', input: 'Hello.', tools: [{ type: 'file_search' }] }).success).toBe(true);
  expect(schema.safeParse({ model: 'gpt-test', input: [{ type: 'message' }] }).success).toBe(false);
  expect(schema.safeParse({ model: 'gpt-test', input: 'Hello.', tools: [{ type: 'function' }] }).success).toBe(false);
});
