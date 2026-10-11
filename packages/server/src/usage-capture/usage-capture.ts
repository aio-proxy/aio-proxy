import type { LiveMetrics } from '../live-metrics';
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

export function createUsageCapture(
  options: { readonly logger?: ServerLogSink; readonly liveMetrics?: LiveMetrics } = {},
): UsageCapture {
  return {
    stream: (streamOptions) => streamCapture(streamOptions, options.logger, options.liveMetrics),
    passthrough: (passthroughOptions) => passthroughCapture(passthroughOptions, options.logger, options.liveMetrics),
    embedding: (embeddingOptions) => embeddingCapture(embeddingOptions, options.logger),
    evaluation: (evaluationOptions) => evaluationCapture(evaluationOptions, options.logger),
  };
}
