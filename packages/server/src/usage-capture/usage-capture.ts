import type { ServerLogSink } from '../server-log';
import { passthroughCapture } from './passthrough-capture';
import type { UsageCapture } from './shared';
import { streamCapture } from './stream-capture';

export type { Captured, PassthroughUsageOptions, StreamUsageOptions, UsageCapture, UsageCompletion } from './shared';

export function createUsageCapture(options: { readonly logger?: ServerLogSink } = {}): UsageCapture {
  return {
    stream: (streamOptions) => streamCapture(streamOptions, options.logger),
    passthrough: (passthroughOptions) => passthroughCapture(passthroughOptions, options.logger),
  };
}
