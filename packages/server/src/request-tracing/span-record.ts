import type { StoredSpan } from '@aio-proxy/core/db';
import type { SpanAttributesJson, SpanEventJson, SpanLinkJson } from '@aio-proxy/core/db/schema/trace-span';
import type { HrTime, Link, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

import { ALLOWED_ATTRIBUTES } from './semantic';

function epochMilliseconds([seconds, nanoseconds]: HrTime): number {
  return seconds * 1_000 + nanoseconds / 1_000_000;
}

function sanitizeAttributes(attributes: SpanAttributesJson): SpanAttributesJson {
  const result: SpanAttributesJson = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (ALLOWED_ATTRIBUTES.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function sanitizeEvents(
  events: ReadonlyArray<{ name: string; time: HrTime; attributes?: SpanAttributesJson }>,
): SpanEventJson[] {
  return events.map((event) => ({
    name: event.name,
    timeMs: Math.round(epochMilliseconds(event.time)),
    attributes: sanitizeAttributes(event.attributes ?? {}),
  }));
}

function sanitizeLinks(links: readonly Link[]): SpanLinkJson[] {
  return links.map((link) => ({
    traceId: link.context.traceId,
    spanId: link.context.spanId,
    attributes: sanitizeAttributes((link.attributes ?? {}) as SpanAttributesJson),
  }));
}

export function spanToRecord(span: ReadableSpan): StoredSpan {
  const ctx = span.spanContext();
  const parentSpanId = span.parentSpanContext?.spanId;
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    name: span.name,
    kind: span.kind as SpanKind,
    startedAt: new Date(epochMilliseconds(span.startTime)),
    endedAt: new Date(epochMilliseconds(span.endTime)),
    statusCode: span.status.code as SpanStatusCode,
    attributes: sanitizeAttributes(span.attributes as SpanAttributesJson),
    events: sanitizeEvents(span.events),
    links: sanitizeLinks(span.links),
  };
}
