import { openai } from '@ai-sdk/openai';
import { type AliasDimensions, canonicalEffort, ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { FilePart, ModelMessage, ToolSet } from '../ai-sdk-bridge';
import { writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from '../egress/openai-responses/index';
import { OpenAIResponsesUnsupportedFeatureError } from '../error';
import { isImageMediaType, openAIImageDetail } from '../image-input';
import { type OpenAIResponsesCompactRequest, parseOpenAIResponsesCompact } from '../ingress/openai-responses/compact';
import { type OpenAIResponsesRequest, parseOpenAIResponses } from '../ingress/openai-responses/index';
import { openAIResponsesToModelMessages, readOpenAIResponsesWireMetadata } from '../transform/openai-responses/index';
import { warnOpenAIResponsesDegradation } from '../transform/openai-responses/tools';
import { defineProtocolAdapter } from './adapter';
import { openAIResponsesErrors } from './errors';
import { openAIResponsesRawRetry } from './openai-responses/encrypted-content-retry';
import { clampSdkReasoning, normalizeEffort, reasoningSetting } from './reasoning-effort/index';
import { readJsonRequest, readRequestText } from './request';
import type { SessionCandidate } from './session';
import { functionToolSet } from './tools';

export type OpenAIResponsesContext = { readonly operation?: 'create' | 'compact' };

export const openAIResponsesAdapter = defineProtocolAdapter<
  OpenAIResponsesRequest | OpenAIResponsesCompactRequest,
  OpenAIResponsesContext
>({
  protocol: ProviderProtocol.OpenAIResponse,
  async parse(raw, context) {
    const body = await readJsonRequest(raw);
    return context.operation === 'compact' ? parseOpenAIResponsesCompact(body) : parseOpenAIResponses(body);
  },
  model: (request) => request.model,
  dimensions: (request, context) => {
    const effort = context.operation === 'compact' ? undefined : optionalText(reasoningEffort(request.reasoning));
    const speed = speedFromServiceTier(optionalText(request.service_tier));
    return {
      ...(effort === undefined ? {} : { effort: canonicalEffort(effort) }),
      ...(speed === undefined ? {} : { speed }),
    };
  },
  requestDiagnostics: (request, context) =>
    context.operation === 'compact'
      ? []
      : request.background === true
        ? [{ feature: 'background', action: 'dropped', effectiveMode: 'synchronous' }]
        : [],
  session: (request, context) => {
    const previousResponseId = context.operation === 'compact' ? undefined : optionalText(request.previous_response_id);
    return {
      candidates: [
        candidate('openai-conversation', conversationId(request.conversation)),
        candidate('openai-prompt-cache', optionalText(request.prompt_cache_key)),
        candidate('body-session', metadataText(request.metadata, 'session_id')),
        candidate('body-conversation', metadataText(request.metadata, 'conversation_id')),
        candidate('body-session', optionalText(request.session_id)),
        candidate('body-conversation', optionalText(request.conversation_id)),
      ].filter(isCandidate),
      ...(previousResponseId === undefined ? {} : { previousResponseId }),
      transcript: request.input,
    };
  },
  wantsStream: (request, context) => context.operation !== 'compact' && request.stream === true,
  async rawRequest(raw, _request, resolvedModel, supportedEfforts, context) {
    if (context.operation === 'compact') {
      return rewriteOpenAIResponsesCompactRequest(raw, resolvedModel);
    }
    return rewriteOpenAIResponsesRequest(raw, resolvedModel, supportedEfforts);
  },
  modelInvocation(request, context) {
    if (context.operation === 'compact') {
      throw new OpenAIResponsesUnsupportedFeatureError('responses_compact', 'POST /v1/responses/compact');
    }
    const transformed = openAIResponsesToModelMessages(request as OpenAIResponsesRequest);
    const tools = functionToolSet(transformed.tools);
    const { reasoning, ...settings } = transformed.settings;
    return {
      messages: transformed.messages,
      settings: { ...settings, ...reasoningSetting(reasoning) },
      ...(tools === undefined ? {} : { tools }),
      ...(transformed.diagnostics.length === 0 ? {} : { diagnostics: transformed.diagnostics }),
    };
  },
  modelInvocationForTarget(invocation, targetProtocol, supportedEfforts) {
    const clamped = clampSdkReasoning(invocation, supportedEfforts);
    if (targetProtocol !== ProviderProtocol.OpenAIResponse) {
      const messages = portableImageDetailMessages(clamped.messages);
      return messages === clamped.messages ? clamped : { ...clamped, messages };
    }
    const tools = responsesToolSet(clamped.tools);
    return {
      ...clamped,
      messages: openAIResponsesMessages(clamped.messages),
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelJson: writeOpenAIResponsesResponse,
  modelSse: writeOpenAIResponsesSSE,
  errors: openAIResponsesErrors,
  rawRetry: openAIResponsesRawRetry,
});

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function metadataText(metadata: unknown, key: 'session_id' | 'conversation_id'): string | undefined {
  return typeof metadata === 'object' && metadata !== null ? optionalText(Reflect.get(metadata, key)) : undefined;
}

function reasoningEffort(reasoning: unknown): unknown {
  return typeof reasoning === 'object' && reasoning !== null ? Reflect.get(reasoning, 'effort') : undefined;
}

function speedFromServiceTier(value: string | undefined): AliasDimensions['speed'] {
  if (value === undefined) return undefined;
  const tier = value.trim().toLowerCase();
  if (tier === 'priority' || tier === 'fast') return 'fast';
  if (tier === 'flex') return 'flex';
  return undefined;
}

type ModelMessagePart = Exclude<ModelMessage['content'], string>[number];

function portableImageDetailMessages(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  let changed = false;
  const portable = messages.map((message, messageIndex) => {
    if (typeof message.content === 'string') return message;
    let messageChanged = false;
    const content = message.content.map((part, partIndex) => {
      const next = portableImageDetailPart(part, `messages.${messageIndex}.content.${partIndex}`);
      if (next !== part) messageChanged = true;
      return next;
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? portable : messages;
}

function portableImageDetailPart(part: ModelMessagePart, path: string): ModelMessagePart {
  if (isCurrentFilePart(part) && isImageMediaType(part.mediaType)) return withoutOpenAIImageDetail(part, path);
  if (part.type !== 'tool-result' || part.output.type !== 'content') return part;

  let changed = false;
  const value = part.output.value.map((outputPart, outputIndex) => {
    if (!isCurrentFilePart(outputPart) || !isImageMediaType(outputPart.mediaType)) return outputPart;
    const next = withoutOpenAIImageDetail(outputPart, `${path}.output.value.${outputIndex}`);
    if (next !== outputPart) changed = true;
    return next;
  });
  return changed ? { ...part, output: { ...part.output, value } } : part;
}

function isCurrentFilePart<T>(part: T): part is Extract<T, { type: 'file' }> {
  return typeof part === 'object' && part !== null && Reflect.get(part, 'type') === 'file';
}

function withoutOpenAIImageDetail<T extends FilePart>(part: T, path: string): T {
  if (openAIImageDetail(part) === undefined) return part;
  const openaiOptions = part.providerOptions?.['openai'];
  if (!isPlainObject(openaiOptions)) return part;

  warnOpenAIResponsesDegradation('image_detail', `${path}.providerOptions.openai.imageDetail`, 'dropped');
  const remainingOpenAIOptions = { ...openaiOptions };
  delete remainingOpenAIOptions['imageDetail'];
  return {
    ...part,
    providerOptions: {
      ...part.providerOptions,
      openai: remainingOpenAIOptions,
    },
  } as T;
}

function responsesToolSet(tools: ToolSet | undefined): ToolSet | undefined {
  if (tools === undefined) return undefined;
  const result: ToolSet = Object.create(null);
  for (const [name, tool] of Object.entries(tools)) {
    const metadata = readOpenAIResponsesWireMetadata(tool.metadata);
    if (metadata?.wireToolType === 'custom') {
      result[name] = {
        ...openai.tools.customTool({
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...(metadata.format === undefined ? {} : { format: metadata.format }),
        }),
        metadata: tool.metadata,
      };
    } else {
      result[name] = tool;
    }
  }
  return result;
}

function openAIResponsesMessages(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-call') return part;
        const metadata = readOpenAIResponsesWireMetadata(part.providerOptions);
        if (metadata?.wireToolType !== 'custom') return part;
        let input: unknown;
        if (typeof part.input === 'string') input = part.input;
        else if (typeof part.input === 'object' && part.input !== null) input = Reflect.get(part.input, 'input');
        return typeof input === 'string' ? { ...part, input } : part;
      }),
    };
  });
}

const jsonObjectSchema = z.object({}).catchall(z.unknown());

async function rewriteOpenAIResponsesCompactRequest(raw: Request, resolvedModel: string): Promise<Request> {
  // Read the decoded body once so a no-op rewrite forwards it verbatim instead
  // of round-tripping through JSON, which would silently truncate large
  // integers and drop the client's exact byte representation.
  const bodyText = await readRequestText(raw);
  const body = jsonObjectSchema.parse(JSON.parse(bodyText));
  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (body['model'] === resolvedModel && !Object.hasOwn(body, 'stream')) {
    return new Request(raw, { method: raw.method, body: bodyText, headers });
  }
  const { stream: _stream, ...bodyWithoutStream } = body;
  return new Request(raw, {
    method: raw.method,
    body: JSON.stringify({ ...bodyWithoutStream, model: resolvedModel }),
    headers,
  });
}

async function rewriteOpenAIResponsesRequest(
  raw: Request,
  resolvedModel: string,
  supportedEfforts: ReadonlySet<string>,
): Promise<Request> {
  // Read the decoded body once so a no-op rewrite forwards it verbatim instead
  // of round-tripping through JSON, which would silently truncate large
  // integers and drop the client's exact byte representation.
  const bodyText = await readRequestText(raw);
  const { background: _background, ...body } = jsonObjectSchema.parse(JSON.parse(bodyText));
  const reasoning = body['reasoning'];
  const nextReasoning =
    typeof reasoning === 'object' &&
    reasoning !== null &&
    typeof (reasoning as { effort?: unknown }).effort === 'string'
      ? { ...reasoning, effort: normalizeEffort((reasoning as { effort: string }).effort, supportedEfforts) }
      : reasoning;
  const headers = new Headers(raw.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  // Any of these force a re-serialization: a model rewrite, a stripped
  // `background` field, or a clamped effort. Only when none apply can we
  // forward the untouched original bytes.
  const modelUnchanged = body['model'] === resolvedModel;
  const backgroundStripped = _background !== undefined;
  const effortUnchanged =
    nextReasoning === reasoning ||
    (typeof reasoning === 'object' &&
      reasoning !== null &&
      (nextReasoning as { effort?: unknown }).effort === (reasoning as { effort?: unknown }).effort);
  const forwardedBody =
    modelUnchanged && !backgroundStripped && effortUnchanged
      ? bodyText
      : JSON.stringify({
          ...body,
          model: resolvedModel,
          ...(nextReasoning === undefined ? {} : { reasoning: nextReasoning }),
        });
  return new Request(raw, {
    method: raw.method,
    body: forwardedBody,
    headers,
  });
}

function conversationId(conversation: unknown): string | undefined {
  if (typeof conversation === 'string') return conversation;
  return typeof conversation === 'object' && conversation !== null
    ? optionalText(Reflect.get(conversation, 'id'))
    : undefined;
}

function candidate(source: SessionCandidate['source'], value: string | undefined): SessionCandidate | undefined {
  return value === undefined ? undefined : { source, value };
}

function isCandidate(value: SessionCandidate | undefined): value is SessionCandidate {
  return value !== undefined;
}
