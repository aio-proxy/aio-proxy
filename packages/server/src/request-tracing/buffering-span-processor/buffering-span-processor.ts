import type { StoredSpan } from '@aio-proxy/core/db';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';

import { markSensitiveSpan } from '../../request-logging/capture-policy';
import { capturesRequestPayload } from '../../request-logging/context';
import { spanToRecord } from '../span-record';

export class BufferingSpanProcessor implements SpanProcessor {
  readonly #buffers = new Map<string, StoredSpan[]>();
  readonly #nextSequence = new Map<string, number>();
  readonly #startSequences = new Map<string, Map<string, number>>();

  register(traceId: string): void {
    if (!this.#buffers.has(traceId)) {
      this.#buffers.set(traceId, []);
      this.#nextSequence.set(traceId, 0);
      this.#startSequences.set(traceId, new Map());
    }
  }

  take(traceId: string): StoredSpan[] {
    const buffer = this.#buffers.get(traceId);
    if (buffer === undefined) return [];
    this.#buffers.delete(traceId);
    this.#nextSequence.delete(traceId);
    this.#startSequences.delete(traceId);
    return buffer;
  }

  abandon(traceId: string): void {
    this.#buffers.delete(traceId);
    this.#nextSequence.delete(traceId);
    this.#startSequences.delete(traceId);
  }

  onStart(span: Span, _parentContext: unknown): void {
    markSensitiveSpan(span, !capturesRequestPayload());
    const context = span.spanContext();
    const sequences = this.#startSequences.get(context.traceId);
    if (sequences === undefined) return;
    const sequence = (this.#nextSequence.get(context.traceId) ?? 0) + 1;
    this.#nextSequence.set(context.traceId, sequence);
    sequences.set(context.spanId, sequence);
  }

  onEnd(span: ReadableSpan): void {
    const buffer = this.#buffers.get(span.spanContext().traceId);
    if (buffer === undefined) return;
    const sequences = this.#startSequences.get(span.spanContext().traceId);
    const startSequence = span.parentSpanContext === undefined ? 0 : sequences?.get(span.spanContext().spanId);
    buffer.push(spanToRecord(span, startSequence));
    sequences?.delete(span.spanContext().spanId);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.#buffers.clear();
    this.#nextSequence.clear();
    this.#startSequences.clear();
    return Promise.resolve();
  }
}
