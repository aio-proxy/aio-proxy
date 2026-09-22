import {
  AnthropicMessageResponseSchema,
  AnthropicMessagesRequestSchema,
  AnthropicMessagesStreamEventSchema,
  OpenAICompletionsRequestSchema,
  OpenAICompletionsResponseSchema,
  OpenAICompletionsStreamEventSchema,
  OpenAIResponsesRequestSchema,
  OpenAIResponsesResponseSchema,
  OpenAIResponsesStreamEventSchema,
} from '@aio-proxy/core';
import type { ZodType } from 'zod';

import { PublicModelListSchema } from '../list-models/public-model-list';

type HttpMethod = 'delete' | 'get' | 'post';
export type PublicOperationClassification = 'documented' | 'deferred' | 'unsupported';

type ClassifiedPublicOperation = {
  readonly classification: Exclude<PublicOperationClassification, 'documented'>;
  readonly method: HttpMethod;
  readonly path: string;
};

type SchemaContent = {
  readonly contentType: 'application/json' | 'text/event-stream';
  readonly schema: ZodType;
};

export type DocumentedPublicOperation = {
  readonly classification: 'documented';
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly operationId: 'listModels' | 'createChatCompletion' | 'createResponse' | 'createMessage';
  readonly slug: 'list-models' | 'chat-completions' | 'responses' | 'messages';
  readonly tag: 'Models' | 'OpenAI' | 'Anthropic';
  readonly navOrder: number;
  readonly messages: {
    readonly title: string;
    readonly description: string;
    readonly note?: string;
  };
  readonly request?: SchemaContent;
  readonly responses: {
    readonly json: SchemaContent;
    readonly stream?: SchemaContent;
  };
};

export type PublicOperation = DocumentedPublicOperation | ClassifiedPublicOperation;

export const publicOperations: readonly PublicOperation[] = [
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
    request: { contentType: 'application/json', schema: OpenAICompletionsRequestSchema },
    responses: {
      json: { contentType: 'application/json', schema: OpenAICompletionsResponseSchema },
      stream: { contentType: 'text/event-stream', schema: OpenAICompletionsStreamEventSchema },
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
    request: { contentType: 'application/json', schema: OpenAIResponsesRequestSchema },
    responses: {
      json: { contentType: 'application/json', schema: OpenAIResponsesResponseSchema },
      stream: { contentType: 'text/event-stream', schema: OpenAIResponsesStreamEventSchema },
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
    request: { contentType: 'application/json', schema: AnthropicMessagesRequestSchema },
    responses: {
      json: { contentType: 'application/json', schema: AnthropicMessageResponseSchema },
      stream: { contentType: 'text/event-stream', schema: AnthropicMessagesStreamEventSchema },
    },
  },
  { classification: 'deferred', method: 'post', path: '/v1/messages/count_tokens' },
  { classification: 'deferred', method: 'post', path: '/v1beta/models/*' },
  { classification: 'deferred', method: 'post', path: '/v1beta/interactions' },
  { classification: 'deferred', method: 'post', path: '/v1/completions' },
  { classification: 'deferred', method: 'post', path: '/v1/embeddings' },
  { classification: 'deferred', method: 'post', path: '/v1/responses/compact' },
  { classification: 'deferred', method: 'post', path: '/v1/images/generations' },
  { classification: 'deferred', method: 'post', path: '/v1/images/edits' },
  { classification: 'deferred', method: 'post', path: '/v1/audio/speech' },
  { classification: 'deferred', method: 'post', path: '/v1/audio/transcriptions' },
  { classification: 'deferred', method: 'post', path: '/v1/audio/translations' },
  { classification: 'deferred', method: 'post', path: '/v1/systemone' },
  { classification: 'deferred', method: 'post', path: '/v1/videos/edits' },
  { classification: 'deferred', method: 'post', path: '/v1/videos/extensions' },
  { classification: 'deferred', method: 'post', path: '/v1/videos' },
  { classification: 'deferred', method: 'post', path: '/v1/videos/:video_id/remix' },
  { classification: 'deferred', method: 'get', path: '/v1/videos/:video_id/content' },
  { classification: 'deferred', method: 'get', path: '/v1/videos/:video_id' },
  { classification: 'deferred', method: 'delete', path: '/v1/videos/:video_id' },
  { classification: 'deferred', method: 'post', path: '/v1/realtime/calls/:call_id/hangup' },
  { classification: 'deferred', method: 'post', path: '/v1/live' },
  { classification: 'deferred', method: 'post', path: '/v1/realtime' },
  { classification: 'deferred', method: 'post', path: '/v1/realtime/calls' },
  { classification: 'deferred', method: 'get', path: '/v1/live/:call_id' },
  { classification: 'deferred', method: 'get', path: '/v1/realtime/calls/:call_id' },
  { classification: 'deferred', method: 'get', path: '/v1/realtime' },
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
