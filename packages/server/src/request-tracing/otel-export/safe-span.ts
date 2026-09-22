import type { Attributes, Link } from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-node';

import { ALLOWED_ATTRIBUTES } from '../semantic';

function filterAttributes(attributes: Attributes | undefined): Attributes {
  const filtered: Attributes = {};
  if (attributes === undefined) return filtered;
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && ALLOWED_ATTRIBUTES.has(key)) filtered[key] = value;
  }
  return filtered;
}

function filterEvents(events: readonly TimedEvent[]): TimedEvent[] {
  return events.map((event) => ({
    name: event.name,
    time: event.time,
    ...(event.attributes === undefined ? {} : { attributes: filterAttributes(event.attributes) }),
  }));
}

function filterLinks(links: readonly Link[]): Link[] {
  return links.map((link) => ({
    context: link.context,
    ...(link.attributes === undefined ? {} : { attributes: filterAttributes(link.attributes) }),
  }));
}

export function toExportableSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes: filterAttributes(span.attributes),
    links: filterLinks(span.links),
    events: filterEvents(span.events),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}
