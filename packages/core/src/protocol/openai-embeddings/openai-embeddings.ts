import { ProviderProtocol } from '@aio-proxy/types';

import { writeOpenAIEmbeddingsResponse } from '../../egress/openai-embeddings';
import { EmbeddingConvertUnsupportedError } from '../../error';
import { type OpenAIEmbeddingsRequest, parseOpenAIEmbeddings } from '../../ingress/openai-embeddings';
import {
  defineEmbeddingProtocolAdapter,
  type EmbeddingProviderOptions,
  type EmbeddingValue,
  type EmptyProtocolContext,
} from '../adapter';
import { openAIEmbeddingsErrors } from '../errors';
import { readJsonRequest, rewriteJsonRequestModel } from '../request';

export const openAIEmbeddingsAdapter = defineEmbeddingProtocolAdapter<OpenAIEmbeddingsRequest, EmptyProtocolContext>({
  capability: 'embedding',
  protocol: ProviderProtocol.OpenAICompatible,
  async parse(raw) {
    return parseOpenAIEmbeddings(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  rawRequest: (raw, _request, resolvedModel) => rewriteJsonRequestModel(raw, resolvedModel),
  embeddingInvocation(request) {
    if (isTokenIdInput(request.input)) {
      throw new EmbeddingConvertUnsupportedError('token-id');
    }
    const providerOptions = embeddingProviderOptions(request);
    const values = (typeof request.input === 'string' ? [request.input] : request.input).map((value): EmbeddingValue =>
      providerOptions === undefined ? { value } : { value, providerOptions },
    );
    return {
      values,
      ...(request.encoding_format === undefined ? {} : { encodingFormat: request.encoding_format }),
    };
  },
  embeddingJson: writeOpenAIEmbeddingsResponse,
  errors: openAIEmbeddingsErrors,
});

function isTokenIdInput(input: OpenAIEmbeddingsRequest['input']): input is number[] | number[][] {
  return Array.isArray(input) && (typeof input[0] === 'number' || Array.isArray(input[0]));
}

function embeddingProviderOptions(request: OpenAIEmbeddingsRequest): EmbeddingProviderOptions | undefined {
  if (request.dimensions === undefined && request.user === undefined) return undefined;
  const options = {
    ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
    ...(request.user === undefined ? {} : { user: request.user }),
  };
  return {
    openai: options,
    openaiCompatible: options,
    ...(request.dimensions === undefined ? {} : { google: { outputDimensionality: request.dimensions } }),
  };
}
