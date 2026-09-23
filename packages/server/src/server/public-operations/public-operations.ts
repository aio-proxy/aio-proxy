import {
  AnthropicMessageResponseSchema,
  AnthropicMessagesRequestSchema,
  AnthropicMessagesStreamEventSchema,
  formatAnthropicMessagesSSE,
  formatOpenAICompletionsSSE,
  formatOpenAIResponsesSSE,
  OpenAICompletionsRequestSchema,
  OpenAICompletionsResponseSchema,
  OpenAICompletionsStreamEventSchema,
  OpenAIResponsesRequestSchema,
  OpenAIResponsesResponseSchema,
  OpenAIResponsesStreamEventSchema,
} from '@aio-proxy/core';
import { z, type ZodType } from 'zod';

import { PublicModelListSchema } from '../list-models/public-model-list';
import { additionalOperations } from './additional-operations';

type HttpMethod = 'delete' | 'get' | 'post';
export type PublicOperationClassification = 'documented' | 'deferred' | 'unsupported';

type ClassifiedPublicOperation = {
  readonly classification: Exclude<PublicOperationClassification, 'documented'>;
  readonly method: HttpMethod;
  readonly path: string;
};

type JsonSchemaContent = {
  readonly contentType: 'application/json';
  readonly schema: ZodType;
};

type StreamSchemaContent = {
  readonly contentType: 'text/event-stream';
  readonly schema: ZodType;
  readonly formatExample: (events: readonly unknown[]) => string;
};

export type DocumentedPublicOperation = {
  readonly classification: 'documented';
  readonly method: HttpMethod;
  readonly path: string;
  readonly routePath?: string;
  readonly operationId: string;
  readonly slug: string;
  readonly tag: 'Models' | 'OpenAI' | 'Anthropic' | 'Gemini' | 'SystemOne' | 'Realtime';
  readonly navOrder: number;
  readonly messages: {
    readonly title: string;
    readonly description: string;
    readonly note?: string;
  };
  readonly request?: JsonSchemaContent;
  readonly requestVariants?: readonly DocumentationContent[];
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: 'path' | 'query' | 'header';
    readonly required?: boolean;
    readonly schema: ZodType;
  }[];
  readonly responseVariants?: readonly {
    readonly status: string;
    readonly description: string;
    readonly content?: readonly DocumentationContent[];
    readonly headers?: Readonly<
      Record<string, { readonly description: string; readonly schema: { readonly type: 'string' } }>
    >;
  }[];
  readonly responses: {
    readonly json?: JsonSchemaContent;
    readonly stream?: StreamSchemaContent;
    readonly text?: {
      readonly contentType: 'text/plain';
      readonly schema: ZodType;
    };
  };
};

export type DocumentationContent = {
  readonly contentType: string;
  readonly schema: ZodType;
};

export type PublicOperation = DocumentedPublicOperation | ClassifiedPublicOperation;

const openAICompletionsRequestDocumentationSchema = OpenAICompletionsRequestSchema.meta({
  examples: [
    { model: 'gpt-5', messages: [{ role: 'user', content: 'Hello.' }] },
    { model: 'gpt-5', messages: [{ role: 'user', content: 'Hello.' }], stream: true },
  ],
});

const openAIResponsesRequestDocumentationSchema = OpenAIResponsesRequestSchema.meta({
  examples: [
    { model: 'gpt-5', input: 'Hello.' },
    { model: 'gpt-5', input: 'Hello.', stream: true },
  ],
});

const rawTextResponse = {
  contentType: 'text/plain' as const,
  schema: z.string().meta({ examples: ['provider-bytes'] }),
};

const anthropicMessagesRequestDocumentationSchema = AnthropicMessagesRequestSchema.loose().meta({
  examples: [
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Hello.' }] },
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Hello.' }], stream: true },
  ],
});

export const publicOperations: readonly PublicOperation[] = [
  ...additionalOperations,
  {
    classification: 'documented',
    method: 'get',
    path: '/v1/models',
    operationId: 'listModels',
    slug: 'list-models',
    tag: 'Models',
    navOrder: 0,
    messages: {
      title: 'operations.listModels.title',
      description: 'operations.listModels.description',
      note: 'operations.listModels.note',
    },
    responses: { json: { contentType: 'application/json', schema: PublicModelListSchema } },
  },
  {
    classification: 'documented',
    method: 'post',
    path: '/v1/chat/completions',
    operationId: 'createChatCompletion',
    slug: 'chat-completions',
    tag: 'OpenAI',
    navOrder: 1,
    messages: {
      title: 'operations.createChatCompletion.title',
      description: 'operations.createChatCompletion.description',
    },
    request: { contentType: 'application/json', schema: openAICompletionsRequestDocumentationSchema },
    responses: {
      json: { contentType: 'application/json', schema: OpenAICompletionsResponseSchema },
      stream: {
        contentType: 'text/event-stream',
        schema: OpenAICompletionsStreamEventSchema,
        formatExample: formatOpenAICompletionsSSE,
      },
      text: rawTextResponse,
    },
  },
  {
    classification: 'documented',
    method: 'post',
    path: '/v1/responses',
    operationId: 'createResponse',
    slug: 'responses',
    tag: 'OpenAI',
    navOrder: 2,
    messages: {
      title: 'operations.createResponse.title',
      description: 'operations.createResponse.description',
    },
    request: { contentType: 'application/json', schema: openAIResponsesRequestDocumentationSchema },
    responses: {
      json: { contentType: 'application/json', schema: OpenAIResponsesResponseSchema },
      stream: {
        contentType: 'text/event-stream',
        schema: OpenAIResponsesStreamEventSchema,
        formatExample: formatOpenAIResponsesSSE,
      },
    },
  },
  {
    classification: 'documented',
    method: 'post',
    path: '/v1/messages',
    operationId: 'createMessage',
    slug: 'messages',
    tag: 'Anthropic',
    navOrder: 3,
    messages: {
      title: 'operations.createMessage.title',
      description: 'operations.createMessage.description',
    },
    request: { contentType: 'application/json', schema: anthropicMessagesRequestDocumentationSchema },
    responses: {
      json: { contentType: 'application/json', schema: AnthropicMessageResponseSchema },
      stream: {
        contentType: 'text/event-stream',
        schema: AnthropicMessagesStreamEventSchema,
        formatExample: formatAnthropicMessagesSSE,
      },
      text: rawTextResponse,
    },
  },
  { classification: 'unsupported', method: 'get', path: '/v1/responses/:id' },
  { classification: 'unsupported', method: 'delete', path: '/v1/responses/:id' },
  { classification: 'unsupported', method: 'post', path: '/v1/responses/:id/cancel' },
  { classification: 'unsupported', method: 'get', path: '/v1/responses/:id/input_items' },
  { classification: 'unsupported', method: 'get', path: '/v1/videos' },
  { classification: 'unsupported', method: 'post', path: '/v1/videos/characters' },
  { classification: 'unsupported', method: 'get', path: '/v1/videos/characters/:character_id' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/client_secrets' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/sessions' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/transcription_sessions' },
  { classification: 'unsupported', method: 'get', path: '/v1/realtime/translations' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/translations' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/translations/client_secrets' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/calls/:call_id/accept' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/calls/:call_id/reject' },
  { classification: 'unsupported', method: 'post', path: '/v1/realtime/calls/:call_id/refer' },
];
