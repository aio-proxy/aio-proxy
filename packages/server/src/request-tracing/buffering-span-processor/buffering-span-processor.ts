import type { StoredSpan } from '@aio-proxy/core/db';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';

import { spanToRecord } from '../span-record';

export class BufferingSpanProcessor implements SpanProcessor {
  readonly #buffers = new Map<string, StoredSpan[]>();

  register(traceId: string): void {
    if (!this.#buffers.has(traceId)) {
      this.#buffers.set(traceId, []);
    }
  }

  take(traceId: string): StoredSpan[] {
    const buffer = this.#buffers.get(traceId);
    if (buffer === undefined) return [];
    this.#buffers.delete(traceId);
    return buffer;
  }

  abandon(traceId: string): void {
    this.#buffers.delete(traceId);
  }

  onStart(_span: Span, _parentContext: unknown): void {}

  onEnd(span: ReadableSpan): void {
    const buffer = this.#buffers.get(span.spanContext().traceId);
    if (buffer === undefined) return;
    buffer.push(spanToRecord(span));
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.#buffers.clear();
    return Promise.resolve();
  }
}
