import type { OtelDestination } from '@aio-proxy/types';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';

import { logServerEvent, type ServerLogSink } from '../../server-log';
import { bindOtelDiag } from './exporters';
import { httpStatusCode } from './http-status';
import { toExportableSpan } from './safe-span';

export type { OtelDestination } from '@aio-proxy/types';

const SERVER_SCOPE = '@aio-proxy/server';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DRAINING = 8;

export type OtelExportDelegator = SpanProcessor & {
  sync(destinations: readonly OtelDestination[]): void;
  stop(): void;
  drainingSize(): number;
};

type Slot = {
  readonly key: string;
  readonly destination: OtelDestination;
  readonly index: number;
  readonly processor: SpanProcessor;
};

function destinationKey(destination: OtelDestination): string {
  const headers = Object.entries(destination.headers).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify([destination.url, destination.contentType, headers]);
}

function originOf(destination: OtelDestination): string {
  return new URL(destination.url).origin;
}

export function createOtelExportDelegator(options: {
  readonly logger: ServerLogSink;
  readonly createProcessor: (destination: OtelDestination, index: number) => SpanProcessor;
  readonly timeoutMs?: number;
}): OtelExportDelegator {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let active: Slot[] = [];
  const draining: Promise<void>[] = [];
  let stopped = false;
  let diagBound = false;

  const retire = (slot: Slot): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    const shutdownPromise = new Promise<void>((resolve) => {
      resolve(slot.processor.shutdown());
    }).catch((error: unknown) => {
      const statusCode = httpStatusCode(error);
      if (statusCode === undefined) return;
      logServerEvent(options.logger, {
        event: 'otel.export',
        category: 'export_failed',
        index: slot.index,
        origin: originOf(slot.destination),
        statusCode,
      });
    });
    const raced = Promise.race([shutdownPromise, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (draining.length >= MAX_DRAINING) return;
    draining.push(raced);
    void raced.finally(() => {
      const at = draining.indexOf(raced);
      if (at !== -1) draining.splice(at, 1);
    });
  };

  const sync = (destinations: readonly OtelDestination[]): void => {
    const pending = new Map<string, number[]>();
    destinations.forEach((destination, index) => {
      const key = destinationKey(destination);
      const indexes = pending.get(key);
      if (indexes === undefined) pending.set(key, [index]);
      else indexes.push(index);
    });

    const kept: Slot[] = [];
    for (const slot of active) {
      const index = pending.get(slot.key)?.shift();
      const destination = index === undefined ? undefined : destinations[index];
      if (index === undefined || destination === undefined) {
        retire(slot);
        continue;
      }
      kept.push({ ...slot, index, destination });
    }
    active = kept;

    const fresh: number[] = [];
    for (const indexes of pending.values()) fresh.push(...indexes);
    fresh.sort((left, right) => left - right);
    for (const index of fresh) {
      const destination = destinations[index];
      if (destination === undefined) continue;
      if (!diagBound) {
        diagBound = true;
        bindOtelDiag(
          () => active.map((slot) => ({ index: slot.index, origin: originOf(slot.destination) })),
          options.logger,
        );
      }
      try {
        active.push({
          key: destinationKey(destination),
          destination,
          index,
          processor: options.createProcessor(destination, index),
        });
      } catch {
        let origin = 'unknown';
        try {
          origin = originOf(destination);
        } catch {
          // A bad URL must not hide this destination's log.
        }
        logServerEvent(options.logger, {
          event: 'otel.export',
          category: 'destination_unavailable',
          index,
          origin,
        });
      }
    }
  };

  const stop = (): void => {
    stopped = true;
    const retiring = active;
    active = [];
    for (const slot of retiring) retire(slot);
  };

  return {
    onStart(_span: Span, _parentContext: Context): void {},
    onEnd(span: ReadableSpan): void {
      if (stopped || span.instrumentationScope.name !== SERVER_SCOPE) return;
      const exportable = toExportableSpan(span);
      for (const slot of active) {
        try {
          slot.processor.onEnd(exportable);
        } catch {
          // One destination must not block the others.
        }
      }
    },
    forceFlush(): Promise<void> {
      return Promise.all(active.map((slot) => slot.processor.forceFlush())).then(() => undefined);
    },
    shutdown(): Promise<void> {
      stop();
      return Promise.resolve();
    },
    sync,
    stop,
    drainingSize(): number {
      return draining.length;
    },
  };
}
