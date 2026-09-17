import type { ModelEventStream } from '@aio-proxy/core';

import type { Recording } from './types';
export declare function jsonRequest(
  body: unknown,
  options?: {
    readonly contentLength?: number | string;
    readonly signal?: AbortSignal;
  },
): Request;
export declare function textStream(text: string): ModelEventStream;
export declare function emptyStream(): ModelEventStream;
export declare function errorStream(error: unknown): ModelEventStream;
export declare function textThenErrorStream(text: string, error: unknown): ModelEventStream;
export declare function cancellableTextStream(text: string, onCancel: (reason: unknown) => void): ModelEventStream;
export declare function settleRecording(recording: Recording): Promise<void>;
//# sourceMappingURL=streams.d.ts.map
