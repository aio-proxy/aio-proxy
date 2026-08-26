import type { EmbeddingResult } from '../../protocol/adapter';

type GeminiEmbeddingsEgressContext = {
  readonly modelId: string;
  readonly action?: 'embedContent' | 'batchEmbedContents';
};

type GeminiEmbeddingValues = {
  readonly values: readonly number[];
};

type GeminiEmbeddingsUsage = {
  readonly usageMetadata: {
    readonly promptTokenCount: number;
  };
};

type GeminiEmbedContentResponse = {
  readonly embedding: GeminiEmbeddingValues;
} & Partial<GeminiEmbeddingsUsage>;

type GeminiBatchEmbedContentsResponse = {
  readonly embeddings: readonly GeminiEmbeddingValues[];
} & Partial<GeminiEmbeddingsUsage>;

export function writeGeminiEmbeddingsResponse(
  result: EmbeddingResult,
  context: GeminiEmbeddingsEgressContext,
): GeminiEmbedContentResponse | GeminiBatchEmbedContentsResponse {
  const usage = usageMetadata(result.usage?.tokens);
  if (context.action === 'batchEmbedContents') {
    return {
      embeddings: result.embeddings.map((values) => ({ values })),
      ...usage,
    };
  }
  return {
    embedding: { values: result.embeddings[0] ?? [] },
    ...usage,
  };
}

function usageMetadata(tokens: number | undefined): GeminiEmbeddingsUsage | Record<never, never> {
  return tokens === undefined ? {} : { usageMetadata: { promptTokenCount: tokens } };
}
