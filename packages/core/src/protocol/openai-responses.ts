import { openai } from '@ai-sdk/openai';
import { ProviderProtocol } from '@aio-proxy/types';
import { z } from 'zod';

import type { AiSdkCallSettings, ModelMessage, ToolSet } from '../ai-sdk-bridge';
import { writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from '../egress/openai-responses/index';
import { type OpenAIResponsesRequest, parseOpenAIResponses } from '../ingress/openai-responses/index';
import { openAIResponsesToModelMessages, readOpenAIResponsesWireMetadata } from '../transform/openai-responses/index';
import { defineProtocolAdapter, type EmptyProtocolContext } from './adapter';
import { openAIResponsesErrors } from './errors';
import { clampSdkReasoning, normalizeEffort } from './reasoning-effort/index';
import { readJsonRequest } from './request';
import type { SessionCandidate } from './session';
import { functionToolSet } from './tools';

export const openAIResponsesAdapter = defineProtocolAdapter<OpenAIResponsesRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.OpenAIResponse,
  async parse(raw) {
    return parseOpenAIResponses(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  variant: (request) => request.reasoning?.effort,
  requestDiagnostics: (request) =>
    request.background === true ? [{ feature: 'background', action: 'dropped', effectiveMode: 'synchronous' }] : [],
  session: (request) => ({
    candidates: [
      candidate('openai-conversation', conversationId(request.conversation)),
      candidate('openai-prompt-cache', request.prompt_cache_key),
      candidate('body-session', request.metadata?.session_id),
      candidate('body-conversation', request.metadata?.conversation_id),
      candidate('body-session', request.session_id),
      candidate('body-conversation', request.conversation_id),
    ].filter(isCandidate),
    ...(request.previous_response_id === undefined ? {} : { previousResponseId: request.previous_response_id }),
    transcript: request.input,
  }),
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, _request, resolvedModel, supportedEfforts) {
    return rewriteOpenAIResponsesRequest(raw, resolvedModel, supportedEfforts);
  },
  modelInvocation(request) {
    const transformed = openAIResponsesToModelMessages(request);
    const tools = functionToolSet(transformed.tools);
    const { reasoning, ...settings } = transformed.settings;
    return {
      messages: transformed.messages,
      settings: { ...settings, ...reasoningSetting(reasoning) },
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelInvocationForTarget(invocation, targetProtocol, supportedEfforts) {
    const clamped = clampSdkReasoning(invocation, supportedEfforts);
    if (targetProtocol !== ProviderProtocol.OpenAIResponse) return clamped;
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
});

function responsesToolSet(tools: ToolSet | undefined): ToolSet | undefined {
  if (tools === undefined) return undefined;
  const result: ToolSet = Object.create(null);
  for (const [name, tool] of Object.entries(tools)) {
    const metadata = readOpenAIResponsesWireMetadata(tool.metadata);
    if (metadata?.wireToolType === 'custom') {
      result[name] = openai.tools.customTool({
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(metadata.format === undefined ? {} : { format: metadata.format }),
      });
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
        const input =
          typeof part.input === 'string'
            ? part.input
            : typeof part.input === 'object' && part.input !== null
              ? Reflect.get(part.input, 'input')
              : undefined;
        return typeof input === 'string' ? { ...part, input } : part;
      }),
    };
  });
}

const jsonObjectSchema = z.object({}).catchall(z.unknown());

async function rewriteOpenAIResponsesRequest(
  raw: Request,
  resolvedModel: string,
  supportedEfforts: ReadonlySet<string>,
): Promise<Request> {
  const { background: _background, ...body } = jsonObjectSchema.parse(await readJsonRequest(raw));
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
  return new Request(raw, {
    method: raw.method,
    body: JSON.stringify({
      ...body,
      model: resolvedModel,
      ...(nextReasoning === undefined ? {} : { reasoning: nextReasoning }),
    }),
    headers,
  });
}

function conversationId(conversation: OpenAIResponsesRequest['conversation']): string | undefined {
  return typeof conversation === 'string' ? conversation : conversation?.id;
}

type AiSdkReasoning = NonNullable<AiSdkCallSettings['reasoning']>;
const AI_SDK_REASONING: readonly AiSdkReasoning[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'provider-default',
];

// Ingress accepts any effort string so a future upstream level is not rejected
// here, but the AI SDK call options only take the levels it knows. Drop an
// unrecognized level and let the provider apply its own default.
function reasoningSetting(effort: string | undefined): { readonly reasoning?: AiSdkReasoning } {
  const known = AI_SDK_REASONING.find((level) => level === effort);
  return known === undefined ? {} : { reasoning: known };
}

function candidate(source: SessionCandidate['source'], value: string | undefined): SessionCandidate | undefined {
  return value === undefined ? undefined : { source, value };
}

function isCandidate(value: SessionCandidate | undefined): value is SessionCandidate {
  return value !== undefined;
}
