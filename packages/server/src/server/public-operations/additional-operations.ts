import {
  AnthropicMessagesRequestSchema,
  GeminiBatchEmbedContentsRequestSchema,
  GeminiEmbedContentRequestSchema,
  GeminiGenerateContentRequestSchema,
  GeminiInteractionsBodySchema,
  OpenAIEmbeddingsRequestSchema,
  OpenAILegacyCompletionsRequestSchema,
  OpenAIResponsesCompactRequestSchema,
} from '@aio-proxy/core';
import { z } from 'zod';

import {
  exampleSchema,
  jsonContent,
  ok,
  operation,
  parameter,
  textContent,
  upstreamObject,
} from './documentation-content';
import { mediaOperations } from './media-operations';
import { realtimeOperations } from './realtime-operations';

const hello = { contents: [{ role: 'user', parts: [{ text: 'Hello.' }] }] };
const geminiReply = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'Hello.' }] }, finishReason: 'STOP', index: 0 }],
};
const embedding = z.object({ values: z.array(z.number()) });
const legacyReply = {
  id: 'cmpl_example',
  object: 'text_completion',
  created: 0,
  model: 'gpt-5',
  choices: [{ index: 0, text: 'Hello.', finish_reason: 'stop', logprobs: null }],
};
const geminiFields = {
  routePath: '/v1beta/models/*',
  parameters: [parameter('model', 'path', z.string().min(1))],
};
const interactionReply = {
  id: 'intr_example',
  object: 'interaction',
  model: 'gemini-2.5-flash',
  status: 'completed',
  created: '1970-01-01T00:00:00.000Z',
  updated: '1970-01-01T00:00:00.000Z',
  steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello.' }] }],
  usage: {
    total_input_tokens: 1,
    total_output_tokens: 1,
    total_tokens: 2,
    total_thought_tokens: 0,
    total_cached_tokens: 0,
    total_tool_use_tokens: 0,
  },
};

export const additionalOperations = [
  operation('post', '/v1/completions', 'createCompletion', 'completions', 'OpenAI', 4, {
    requestVariants: [
      jsonContent(
        exampleSchema(
          OpenAILegacyCompletionsRequestSchema,
          { model: 'gpt-5', prompt: 'Hello.' },
          { model: 'gpt-5', prompt: 'Hello.', stream: true },
        ),
      ),
    ],
    responseVariants: ok(
      jsonContent(upstreamObject(legacyReply)),
      textContent('text/event-stream', `data: ${JSON.stringify(legacyReply)}\n\ndata: [DONE]\n\n`),
    ),
  }),
  operation('post', '/v1/embeddings', 'createEmbedding', 'embeddings', 'OpenAI', 5, {
    requestVariants: [
      jsonContent(exampleSchema(OpenAIEmbeddingsRequestSchema, { model: 'text-embedding-3-small', input: 'Hello.' })),
    ],
    responseVariants: ok(
      jsonContent(
        exampleSchema(
          z
            .object({
              object: z.literal('list'),
              model: z.string(),
              data: z.array(
                z.object({
                  object: z.literal('embedding'),
                  index: z.number(),
                  embedding: z.union([z.array(z.number()), z.string()]),
                }),
              ),
              usage: z.object({ prompt_tokens: z.number(), total_tokens: z.number() }),
            })
            .loose(),
          {
            object: 'list',
            model: 'text-embedding-3-small',
            data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          },
        ),
      ),
    ),
  }),
  operation('post', '/v1/responses/compact', 'compactResponse', 'compact-response', 'OpenAI', 6, {
    requestVariants: [
      jsonContent(
        exampleSchema(
          OpenAIResponsesCompactRequestSchema.extend({
            model: z.string().min(1),
            stream: z.literal(false).nullable().optional(),
          }),
          { model: 'gpt-5', input: 'Hello.' },
        ),
      ),
    ],
    responseVariants: ok(
      jsonContent(upstreamObject({ id: 'resp_example', object: 'response.compaction', output: [] })),
    ),
  }),
  operation('post', '/v1/messages/count_tokens', 'countMessageTokens', 'count-message-tokens', 'Anthropic', 7, {
    requestVariants: [
      jsonContent(
        exampleSchema(AnthropicMessagesRequestSchema, {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Hello.' }],
        }),
      ),
    ],
    responseVariants: ok(jsonContent(exampleSchema(z.object({ input_tokens: z.number() }), { input_tokens: 1 }))),
  }),
  operation('post', '/v1beta/models/{model}:generateContent', 'generateContent', 'generate-content', 'Gemini', 8, {
    ...geminiFields,
    requestVariants: [jsonContent(exampleSchema(GeminiGenerateContentRequestSchema.omit({ model: true }), hello))],
    responseVariants: ok(jsonContent(upstreamObject(geminiReply))),
  }),
  operation(
    'post',
    '/v1beta/models/{model}:streamGenerateContent',
    'streamGenerateContent',
    'stream-generate-content',
    'Gemini',
    9,
    {
      ...geminiFields,
      parameters: [...geminiFields.parameters, parameter('alt', 'query', z.string().meta({ examples: ['sse'] }))],
      requestVariants: [jsonContent(exampleSchema(GeminiGenerateContentRequestSchema.omit({ model: true }), hello))],
      responseVariants: ok(textContent('text/event-stream', `data: ${JSON.stringify(geminiReply)}\n\n`)),
    },
  ),
  operation('post', '/v1beta/models/{model}:countTokens', 'countContentTokens', 'count-content-tokens', 'Gemini', 10, {
    ...geminiFields,
    requestVariants: [jsonContent(exampleSchema(GeminiGenerateContentRequestSchema.omit({ model: true }), hello))],
    responseVariants: ok(jsonContent(exampleSchema(z.object({ totalTokens: z.number() }), { totalTokens: 1 }))),
  }),
  operation('post', '/v1beta/models/{model}:embedContent', 'embedContent', 'embed-content', 'Gemini', 11, {
    ...geminiFields,
    requestVariants: [
      jsonContent(exampleSchema(GeminiEmbedContentRequestSchema, { content: { parts: [{ text: 'Hello.' }] } })),
    ],
    responseVariants: ok(
      jsonContent(
        exampleSchema(z.object({ embedding, usageMetadata: z.object({ promptTokenCount: z.number() }).optional() }), {
          embedding: { values: [0.1, 0.2] },
        }),
      ),
    ),
  }),
  operation(
    'post',
    '/v1beta/models/{model}:batchEmbedContents',
    'batchEmbedContents',
    'batch-embed-contents',
    'Gemini',
    12,
    {
      ...geminiFields,
      requestVariants: [
        jsonContent(
          exampleSchema(GeminiBatchEmbedContentsRequestSchema, {
            requests: [{ content: { parts: [{ text: 'Hello.' }] } }],
          }),
        ),
      ],
      responseVariants: ok(
        jsonContent(
          exampleSchema(
            z.object({
              embeddings: z.array(embedding),
              usageMetadata: z.object({ promptTokenCount: z.number() }).optional(),
            }),
            { embeddings: [{ values: [0.1, 0.2] }] },
          ),
        ),
      ),
    },
  ),
  operation('post', '/v1beta/interactions', 'createInteraction', 'interactions', 'Gemini', 13, {
    requestVariants: [
      jsonContent(
        exampleSchema(
          GeminiInteractionsBodySchema,
          { model: 'gemini-2.5-flash', input: 'Hello.' },
          { model: 'gemini-2.5-flash', input: 'Hello.', stream: true },
        ),
      ),
    ],
    responseVariants: ok(
      jsonContent(upstreamObject(interactionReply)),
      textContent(
        'text/event-stream',
        `event: interaction.completed\ndata: ${JSON.stringify({ event_id: 'evt_1', event_type: 'interaction.completed', interaction: interactionReply })}\n\nevent: done\ndata: [DONE]\n\n`,
      ),
    ),
  }),
  ...mediaOperations,
  ...realtimeOperations,
];
