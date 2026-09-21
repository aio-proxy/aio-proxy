import type { ServerLogSink } from '../server-log';
import { embeddingCapture } from './embedding-capture';
import { evaluationCapture } from './evaluation-capture';
import { passthroughCapture } from './passthrough-capture';
import type { UsageCapture } from './shared';
import { streamCapture } from './stream-capture';

export type {
  Captured,
  EmbeddingUsageOptions,
  EvaluationUsageOptions,
  PassthroughUsageOptions,
  StreamUsageOptions,
  UsageCapture,
  UsageCompletion,
} from './shared';

export function createUsageCapture(options: { readonly logger?: ServerLogSink } = {}): UsageCapture {
  return {
    stream: (streamOptions) => streamCapture(streamOptions, options.logger),
    passthrough: (passthroughOptions) => passthroughCapture(passthroughOptions, options.logger),
    embedding: (embeddingOptions) => embeddingCapture(embeddingOptions, options.logger),
    evaluation: (evaluationOptions) => evaluationCapture(evaluationOptions, options.logger),
  };
}
