import {
  createPassthroughSseUsageObserver,
  extractPassthroughObservation,
  type PassthroughObservation,
  type PassthroughSseUsageObserver,
} from '../../passthrough-usage';
import { MAX_PASSTHROUGH_JSON_BYTES, observeContentAt, type PassthroughUsageOptions } from '../shared';
import { createJsonUsageScan } from './json-usage-scan';

export type ObservationSource = {
  // Feed one upstream body chunk into the observer / JSON buffer.
  readonly feed: (chunk: Uint8Array) => void;
  // Final observation once the body ends (SSE flush or buffered JSON parse).
  readonly final: () => PassthroughObservation;
};

// Owns how a passthrough body is turned into a PassthroughObservation: an SSE
// observer for event streams, or a size-capped JSON buffer otherwise. When the
// JSON body exceeds the cap, a streaming scan still extracts a top-level
// `usage` / `usageMetadata` object so large embedding payloads keep billing.
export function createObservationSource(
  isSse: boolean,
  protocol: PassthroughUsageOptions['protocol'],
  observation: PassthroughUsageOptions['observation'],
  callbacks: {
    readonly onContent: (at: number) => void;
    readonly onTerminal: (observation: PassthroughObservation) => void;
  },
): ObservationSource {
  if (isSse) {
    const observer = createSseUsageObserver(protocol, observation, callbacks);
    const decoder = new TextDecoder();
    return {
      feed: (chunk) => observer.feed(decoder.decode(chunk, { stream: true })),
      final: () => finishSseObservation(observer, decoder),
    };
  }
  const jsonCapture = createJsonCapture();
  const usageScan = createJsonUsageScan();
  return {
    feed: (chunk) => {
      jsonCapture.push(chunk);
      usageScan.push(chunk);
    },
    final: () => {
      usageScan.finish();
      if (jsonCapture.captured()) return extractPassthroughObservation(protocol, jsonCapture.text());
      const snippet = usageScan.text();
      return snippet === undefined ? {} : extractPassthroughObservation(protocol, snippet);
    },
  };
}

function finishSseObservation(observer: PassthroughSseUsageObserver, decoder: TextDecoder): PassthroughObservation {
  observer.feed(decoder.decode());
  return observer.finish();
}

function createSseUsageObserver(
  protocol: PassthroughUsageOptions['protocol'],
  observation: PassthroughUsageOptions['observation'],
  callbacks: {
    readonly onContent: (at: number) => void;
    readonly onTerminal: (observation: PassthroughObservation) => void;
  },
): PassthroughSseUsageObserver {
  const onEvent = observation?.observeSseEvent;
  return createPassthroughSseUsageObserver(protocol, {
    ...(onEvent === undefined ? {} : { onEvent }),
    onContent: () => callbacks.onContent(observeContentAt(observation)),
    onTerminal: callbacks.onTerminal,
  });
}

type JsonCapture = {
  // Accumulate a body chunk while under the size cap; once exceeded, capture is
  // permanently disabled and buffered bytes are dropped to bound memory.
  readonly push: (chunk: Uint8Array) => void;
  // Whether the full body is still buffered (never exceeded the cap).
  readonly captured: () => boolean;
  // Decoded UTF-8 text of the buffered body; empty once capture is disabled.
  readonly text: () => string;
};

function createJsonCapture(): JsonCapture {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let active = true;
  return {
    captured: () => active,
    push: (chunk) => {
      if (!active) return;
      const nextByteLength = byteLength + chunk.byteLength;
      if (nextByteLength > MAX_PASSTHROUGH_JSON_BYTES) {
        chunks.length = 0;
        byteLength = 0;
        active = false;
        return;
      }
      chunks.push(chunk);
      byteLength = nextByteLength;
    },
    text: () => {
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    },
  };
}
