import { EmbeddingUsageRequiredError } from '../../error';
import type { EmbeddingResult } from '../../protocol/adapter';

type OpenAIEmbeddingsEgressContext = {
  readonly modelId: string;
  readonly encodingFormat?: 'float' | 'base64';
};

type OpenAIEmbeddingsResponse = {
  readonly object: 'list';
  readonly data: readonly {
    readonly object: 'embedding';
    readonly index: number;
    readonly embedding: readonly number[] | string;
  }[];
  readonly model: string;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly total_tokens: number;
  };
};

export function writeOpenAIEmbeddingsResponse(
  result: EmbeddingResult,
  context: OpenAIEmbeddingsEgressContext,
): OpenAIEmbeddingsResponse {
  const tokens = result.usage?.tokens;
  if (tokens === undefined) {
    throw new EmbeddingUsageRequiredError();
  }
  return {
    object: 'list',
    data: result.embeddings.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding: encodeEmbedding(embedding, context.encodingFormat),
    })),
    model: context.modelId,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

function encodeEmbedding(
  embedding: readonly number[],
  encodingFormat: OpenAIEmbeddingsEgressContext['encodingFormat'],
): readonly number[] | string {
  if (encodingFormat !== 'base64') return embedding;
  const floats = Float32Array.from(embedding);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}
