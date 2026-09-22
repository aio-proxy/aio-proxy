import { describe, expect, test } from 'bun:test';

import { dereference, validate } from '@scalar/openapi-parser';
import { fromJSONSchema } from 'zod';

import { AnthropicMessagesRequestSchema, OpenAIResponsesRequestSchema } from '../../../packages/core/dist/index.js';
import { projectOperation } from '../operation-document/index';
import { loadPublicOpenApi, operationSlugs } from './index';

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
