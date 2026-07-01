import type { DashboardEvent } from "@aio-proxy/types";

export type DashboardEventLimits = {
  readonly maxEvents: number;
  readonly maxBytes: number;
};

export type DashboardEventHub = {
  readonly publish: (event: DashboardEvent) => void;
  readonly stream: () => ReadableStream<Uint8Array>;
  readonly close: () => void;
};

type Subscriber = {
  readonly id: number;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  outstandingBytes: number;
  outstandingEvents: number;
};

type TraceDeltaEvent = Extract<
  DashboardEvent,
  { readonly event: "trace.delta" }
>;

const encoder = new TextEncoder();
const defaultLimits = {
  maxBytes: 5 * 1_024 * 1_024,
  maxEvents: 1_000,
} as const;

export function createDashboardEventHub(
  limits: DashboardEventLimits = defaultLimits,
): DashboardEventHub {
  let nextSubscriberId = 1;
  const subscribers = new Map<number, Subscriber>();
  const pendingTraceDeltas = new Map<string, DashboardEvent>();
  const traceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function publish(event: DashboardEvent): void {
    if (event.event === "trace.delta") {
      coalesceTraceDelta(event);
      return;
    }

    publishNow(event);
  }

  function publishNow(event: DashboardEvent): void {
    const bytes = encodeEvent(event);
    for (const subscriber of subscribers.values()) {
      push(subscriber, bytes);
    }
  }

  function stream(): ReadableStream<Uint8Array> {
    const subscriber: Subscriber = {
      id: nextSubscriberId,
      closed: false,
      outstandingBytes: 0,
      outstandingEvents: 0,
    };
    nextSubscriberId += 1;
    subscribers.set(subscriber.id, subscriber);

    return new ReadableStream<Uint8Array>({
      cancel() {
        closeSubscriber(subscriber, false);
      },
      pull() {
        subscriber.outstandingBytes = 0;
        subscriber.outstandingEvents = 0;
      },
      start(controller) {
        subscriber.controller = controller;
      },
    });
  }

  function close(): void {
    for (const timer of traceTimers.values()) {
      clearTimeout(timer);
    }
    traceTimers.clear();
    pendingTraceDeltas.clear();
    for (const subscriber of subscribers.values()) {
      closeSubscriber(subscriber, true);
    }
  }

  function coalesceTraceDelta(event: TraceDeltaEvent): void {
    const traceId = event.data.trace_id;
    pendingTraceDeltas.set(traceId, event);
    if (traceTimers.has(traceId)) {
      return;
    }

    traceTimers.set(
      traceId,
      setTimeout(() => {
        traceTimers.delete(traceId);
        const pending = pendingTraceDeltas.get(traceId);
        pendingTraceDeltas.delete(traceId);
        if (pending !== undefined) {
          publishNow(pending);
        }
      }, 50),
    );
  }

  function push(subscriber: Subscriber, bytes: Uint8Array): void {
    if (subscriber.closed) {
      return;
    }

    if (
      subscriber.outstandingEvents >= limits.maxEvents ||
      subscriber.outstandingBytes + bytes.byteLength > limits.maxBytes
    ) {
      const dropped = encodeEvent({
        event: "events.dropped",
        data: {
          queuedBytes: subscriber.outstandingBytes,
          queuedEvents: subscriber.outstandingEvents,
        },
      });
      subscriber.controller?.enqueue(dropped);
      closeSubscriber(subscriber, true);
      return;
    }

    subscriber.controller?.enqueue(bytes);
    subscriber.outstandingBytes += bytes.byteLength;
    subscriber.outstandingEvents += 1;
  }

  function closeSubscriber(
    subscriber: Subscriber,
    closeController: boolean,
  ): void {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    subscribers.delete(subscriber.id);
    if (closeController) {
      subscriber.controller?.close();
    }
  }

  return { close, publish, stream };
}

function encodeEvent(event: DashboardEvent): Uint8Array {
  return encoder.encode(
    `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
  );
}
