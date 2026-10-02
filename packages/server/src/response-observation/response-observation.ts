import { AsyncLocalStorage } from 'node:async_hooks';

import type { Context } from '@opentelemetry/api';

import { normalizeContentEncoding } from './content-encoding';
import { createSendResponseObservation, observedResponseSend, type SendResponseObservation } from './send-observation';

export type TransportObservation = 'sse' | 'body' | 'unavailable' | 'ambiguous';

export type AttemptResponseSnapshot = {
  readonly transportObservation?: TransportObservation;
  readonly upstreamHeadersMs?: number;
  readonly firstUpstreamByteMs?: number;
  readonly firstSseEventMs?: number;
  readonly firstContentMs?: number;
  readonly contentGapP95Ms?: number;
  readonly maxSseFramesPerRead?: number;
  readonly contentEncoding?: 'identity' | 'gzip' | 'deflate' | 'br' | 'zstd' | 'multiple' | 'other';
  // Upstream HTTP sends started inside this one attempt. Counted at fetch start
  // so a timeout/reset that never produced a Response still counts. >1 means
  // same-provider retries happened underneath us: raw-retry's hidden replay (at
  // most one), or the AI SDK's maxRetries, which defaults to 2 and that we never
  // set. Those retries are invisible to the SDK's own callbacks --
  // onLanguageModelCallStart fires outside its retry() wrapper -- so the HTTP
  // layer is the only place they can be counted.
  readonly httpSends?: number;
  readonly responseSendIndex?: number;
  readonly serverAddress?: string;
  readonly serverPort?: number;
};

export type AttemptResponseEndpoint = Pick<AttemptResponseSnapshot, 'serverAddress' | 'serverPort'> & {
  readonly serverAddress: string;
};

export type ResponseBodyObservation = {
  readonly observeRead: (byteLength: number, sseFrames: number) => void;
};

export type AttemptResponseObservation = {
  readonly parentContext?: Context | undefined;
  readonly bindParentContext?: (context: Context) => void;
  readonly markTransportUnavailable: () => void;
  readonly observeFetchStart: (endpoint?: AttemptResponseEndpoint) => SendResponseObservation | void;
  readonly selectResponse?: (response: Response) => void;
  readonly finishSends?: (succeeded?: boolean) => void;
  readonly observeResponse: (
    response: Response,
    options: { readonly controlledStream: boolean },
  ) => ResponseBodyObservation | undefined;
  readonly observeSseEvent: (at?: number) => void;
  readonly observeContent: (at?: number) => number;
  readonly snapshot: () => AttemptResponseSnapshot;
};

type ContentEncoding = NonNullable<AttemptResponseSnapshot['contentEncoding']>;

const GAP_BUCKET_UPPER_BOUNDS = [
  ...Array.from({ length: 251 }, (_, value) => value),
  ...Array.from({ length: 75 }, (_, value) => 260 + value * 10),
  ...Array.from({ length: 90 }, (_, value) => 1_100 + value * 100),
  ...Array.from({ length: 50 }, (_, value) => 11_000 + value * 1_000),
];

const storage = new AsyncLocalStorage<AttemptResponseObservation>();

export function createAttemptResponseObservation(options: {
  readonly startedAt: number;
  readonly now?: () => number;
  readonly parentContext?: Context;
}): AttemptResponseObservation {
  const now = options.now ?? performance.now.bind(performance);
  const gapBuckets = new Uint32Array(GAP_BUCKET_UPPER_BOUNDS.length + 1);
  let transportObservation: TransportObservation | undefined;
  let sendCount = 0;
  let endpoint: AttemptResponseEndpoint | undefined;
  let endpointAmbiguous = false;
  let responseCount = 0;
  let upstreamHeadersMs: number | undefined;
  let firstUpstreamByteMs: number | undefined;
  let firstSseEventMs: number | undefined;
  let maxSseFramesPerRead: number | undefined;
  let contentEncoding: ContentEncoding | undefined;
  let firstContentMs: number | undefined;
  let lastContentAt: number | undefined;
  let gapCount = 0;
  let overflowMax = 0;
  const sends: SendResponseObservation[] = [];
  let responseSendIndex: number | undefined;
  let explicitResponse = false;
  let contentObserved = false;
  let sendsFinished = false;
  let parentContext = options.parentContext;
  const selectContentSource = (content = false) => {
    if (explicitResponse) return;
    let eligible = sends.filter((send) => send.isContentSource());
    // A decoder may have queued content before a body failure became visible.
    // Content still identifies its sole response; failed earlier retries do not
    // compete with a viable response that actually produced the current output.
    if (content && eligible.length === 0) eligible = sends.filter((send) => send.isContentSource(true));
    responseSendIndex = eligible.length === 1 ? eligible[0]!.index : undefined;
    if (content && responseSendIndex !== undefined) sends[responseSendIndex]?.observeContent();
  };

  const elapsed = (at: number) => Math.round(Math.max(0, at - options.startedAt));

  return {
    get parentContext() {
      return parentContext;
    },
    bindParentContext(context) {
      parentContext ??= context;
    },
    markTransportUnavailable() {
      if (responseCount === 0) transportObservation = 'unavailable';
    },
    observeFetchStart(target) {
      if (sendsFinished) return;
      sendCount++;
      if (target !== undefined && !endpointAmbiguous) {
        if (endpoint === undefined) endpoint = target;
        else if (endpoint.serverAddress !== target.serverAddress || endpoint.serverPort !== target.serverPort) {
          endpoint = undefined;
          endpointAmbiguous = true;
        }
      }
      if (transportObservation === 'unavailable') transportObservation = undefined;
      const send = createSendResponseObservation(sendCount - 1);
      sends.push(send);
      return send;
    },
    selectResponse(response) {
      explicitResponse = true;
      const send = observedResponseSend(response);
      responseSendIndex = send !== undefined && sends.includes(send) ? send.index : undefined;
    },
    finishSends(succeeded = false) {
      if (sendsFinished) return;
      sendsFinished = true;
      if (contentObserved || succeeded) selectContentSource();
      for (const send of sends) {
        if (send.index === responseSendIndex) send.select();
        send.finish();
      }
      sends.length = 0;
    },
    observeResponse(response, { controlledStream }) {
      responseCount++;
      if (responseCount > 1) {
        lastContentAt = undefined;
        transportObservation = 'ambiguous';
        return undefined;
      }

      transportObservation = isSse(response) ? 'sse' : 'body';
      upstreamHeadersMs = elapsed(now());
      if (!controlledStream) return undefined;
      contentEncoding = normalizeContentEncoding(response.headers.get('content-encoding'));

      return {
        observeRead(byteLength, sseFrames) {
          if (responseCount !== 1) return;
          if (byteLength > 0 && firstUpstreamByteMs === undefined) firstUpstreamByteMs = elapsed(now());
          if (byteLength > 0 && transportObservation === 'sse' && contentEncoding === 'identity') {
            maxSseFramesPerRead = Math.max(maxSseFramesPerRead ?? 0, sseFrames);
          }
        },
      };
    },
    observeSseEvent(at = now()) {
      if (responseCount === 1 && transportObservation === 'sse' && firstSseEventMs === undefined) {
        firstSseEventMs = elapsed(at);
      }
    },
    observeContent(at = now()) {
      contentObserved = true;
      selectContentSource(true);
      firstContentMs ??= elapsed(at);
      if (lastContentAt !== undefined) {
        const gap = Math.max(0, at - lastContentAt);
        const bucket = gapBucket(gap);
        gapBuckets[bucket] = gapBuckets[bucket]! + 1;
        gapCount++;
        if (bucket === GAP_BUCKET_UPPER_BOUNDS.length) overflowMax = Math.max(overflowMax, gap);
      }
      lastContentAt = at;
      return at;
    },
    snapshot() {
      const raw = responseCount === 1;
      const contentGapP95Ms = gapCount === 0 ? undefined : gapP95(gapBuckets, gapCount, overflowMax);
      return {
        ...(transportObservation === undefined ? {} : { transportObservation }),
        ...(raw && upstreamHeadersMs !== undefined ? { upstreamHeadersMs } : {}),
        ...(raw && firstUpstreamByteMs !== undefined ? { firstUpstreamByteMs } : {}),
        ...(raw && firstSseEventMs !== undefined ? { firstSseEventMs } : {}),
        // 不走 observed fetch 的 provider 也有内容流，所以这里不能用 raw 闸门；
        // 只有 attempt 内隐藏重试（ambiguous）才让首内容无法归因。
        ...(transportObservation === 'ambiguous' || firstContentMs === undefined ? {} : { firstContentMs }),
        ...(contentGapP95Ms === undefined ? {} : { contentGapP95Ms }),
        ...(raw && maxSseFramesPerRead !== undefined ? { maxSseFramesPerRead } : {}),
        ...(raw && contentEncoding !== undefined ? { contentEncoding } : {}),
        ...(sendCount === 0 ? {} : { httpSends: sendCount }),
        ...(responseSendIndex === undefined ? {} : { responseSendIndex }),
        ...(endpoint === undefined ? {} : endpoint),
      };
    },
  };
}

export function withAttemptResponseObservation<T>(observation: AttemptResponseObservation, operation: () => T): T {
  return storage.run(observation, operation);
}

export function currentAttemptResponseObservation(): AttemptResponseObservation | undefined {
  return storage.getStore();
}

function isSse(response: Response): boolean {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

function gapBucket(gap: number): number {
  let low = 0;
  let high = GAP_BUCKET_UPPER_BOUNDS.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (gap <= GAP_BUCKET_UPPER_BOUNDS[middle]!) high = middle;
    else low = middle + 1;
  }
  return low;
}

function gapP95(counts: Uint32Array, count: number, overflowMax: number): number {
  const rank = Math.ceil(count * 0.95);
  let seen = 0;
  for (let bucket = 0; bucket < counts.length; bucket++) {
    seen += counts[bucket]!;
    if (seen < rank) continue;
    return bucket === GAP_BUCKET_UPPER_BOUNDS.length ? Math.round(overflowMax) : GAP_BUCKET_UPPER_BOUNDS[bucket]!;
  }
  return Math.round(overflowMax);
}
