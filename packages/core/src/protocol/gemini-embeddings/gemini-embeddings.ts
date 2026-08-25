import { ProviderProtocol } from '@aio-proxy/types';

import { writeGeminiEmbeddingsResponse } from '../../egress/gemini-embeddings';
import {
  type GeminiBatchEmbedContentsRequest,
  type GeminiEmbedContentRequest,
  parseGeminiBatchEmbedContents,
  parseGeminiEmbedContent,
} from '../../ingress/gemini-embeddings';
import { defineEmbeddingProtocolAdapter, type EmbeddingProviderOptions, type EmbeddingValue } from '../adapter';
import { geminiEmbeddingsErrors } from '../errors';
import { readJsonRequest } from '../request';

export type GeminiEmbeddingsRequest = GeminiEmbedContentRequest | GeminiBatchEmbedContentsRequest;

export type GeminiEmbeddingsContext = {
  readonly model: string;
  readonly action: 'embedContent' | 'batchEmbedContents';
};

export const geminiEmbeddingsAdapter = defineEmbeddingProtocolAdapter<GeminiEmbeddingsRequest, GeminiEmbeddingsContext>(
  {
    capability: 'embedding',
    protocol: ProviderProtocol.Gemini,
    async parse(raw, context) {
      const body = await readJsonRequest(raw);
      if (context.action === 'batchEmbedContents') {
        return parseGeminiBatchEmbedContents(body);
      }
      return parseGeminiEmbedContent(
        body !== null && typeof body === 'object' && !Array.isArray(body) ? { ...body, model: context.model } : body,
      );
    },
    model: (_request, context) => context.model,
    async rawRequest(raw, request, resolvedModel, context) {
      const url = new URL(raw.url);
      url.pathname = `/v1beta/models/${encodeURIComponent(resolvedModel)}:${context.action}`;
      const headers = new Headers(raw.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Request(url, {
        method: raw.method,
        headers,
        body: JSON.stringify(rewriteBodyModel(request, resolvedModel, context)),
        signal: raw.signal,
      });
    },
    embeddingInvocation(request, context) {
      const items = isBatchRequest(request, context) ? request.requests : [request];
      return { values: items.map(embeddingValue) };
    },
    embeddingJson: writeGeminiEmbeddingsResponse,
    errors: geminiEmbeddingsErrors,
  },
);

function rewriteBodyModel(
  request: GeminiEmbeddingsRequest,
  resolvedModel: string,
  context: GeminiEmbeddingsContext,
): GeminiEmbeddingsRequest {
  const model = `models/${resolvedModel}`;
  if (isBatchRequest(request, context)) {
    return {
      ...request,
      requests: request.requests.map((item) => ({ ...item, model })),
    };
  }
  return { ...request, model };
}

function isBatchRequest(
  request: GeminiEmbeddingsRequest,
  context: GeminiEmbeddingsContext,
): request is GeminiBatchEmbedContentsRequest {
  return context.action === 'batchEmbedContents' && 'requests' in request;
}

function embeddingValue(item: GeminiEmbedContentRequest): EmbeddingValue {
  const value = item.content.parts.map((part) => part.text).join('');
  const providerOptions = embeddingProviderOptions(item);
  return providerOptions === undefined ? { value } : { value, providerOptions };
}

function embeddingProviderOptions(item: GeminiEmbedContentRequest): EmbeddingProviderOptions | undefined {
  const config = item.embedContentConfig;
  const taskType = omitUnspecifiedTaskType(config?.taskType ?? item.taskType);
  const title = config?.title ?? item.title;
  const outputDimensionality = config?.outputDimensionality ?? item.outputDimensionality;
  const autoTruncate = config?.autoTruncate;
  const google = {
    ...(taskType === undefined ? {} : { taskType }),
    ...(title === undefined ? {} : { title }),
    ...(outputDimensionality === undefined ? {} : { outputDimensionality }),
    ...(autoTruncate === undefined ? {} : { autoTruncate }),
  };
  if (Object.keys(google).length === 0) return undefined;
  return {
    google,
    ...(outputDimensionality === undefined
      ? {}
      : { openai: { dimensions: outputDimensionality }, openaiCompatible: { dimensions: outputDimensionality } }),
  };
}

function omitUnspecifiedTaskType(taskType: string | undefined): string | undefined {
  return taskType === undefined || taskType === 'TASK_TYPE_UNSPECIFIED' ? undefined : taskType;
}
