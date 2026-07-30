import { AsyncLocalStorage } from 'node:async_hooks';

export type TransportObservation = 'sse' | 'body' | 'unavailable' | 'ambiguous';

export type AttemptResponseSnapshot = {
  readonly transportObservation?: TransportObservation;
  readonly upstreamHeadersMs?: number;
  readonly firstUpstreamByteMs?: number;
  readonly firstSseEventMs?: number;
  readonly contentGapP95Ms?: number;
  readonly maxSseFramesPerRead?: number;
  readonly contentEncoding?: 'identity' | 'gzip' | 'deflate' | 'br' | 'zstd' | 'multiple' | 'other';
};

export type ResponseBodyObservation = {
  readonly observeRead: (byteLength: number, sseFrames: number) => void;
};

export type AttemptResponseObservation = {
  readonly markTransportUnavailable: () => void;
  readonly observeFetchStart: () => void;
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
}): AttemptResponseObservation {
  const now = options.now ?? performance.now.bind(performance);
  const gapBuckets = new Uint32Array(GAP_BUCKET_UPPER_BOUNDS.length + 1);
  let transportObservation: TransportObservation | undefined;
  let responseCount = 0;
  let upstreamHeadersMs: number | undefined;
  let firstUpstreamByteMs: number | undefined;
  let firstSseEventMs: number | undefined;
  let maxSseFramesPerRead: number | undefined;
  let contentEncoding: ContentEncoding | undefined;
  let lastContentAt: number | undefined;
  let gapCount = 0;
  let overflowMax = 0;

  const elapsed = (at: number) => Math.round(Math.max(0, at - options.startedAt));

  return {
    markTransportUnavailable() {
      if (responseCount === 0) transportObservation = 'unavailable';
    },
    observeFetchStart() {
      if (transportObservation === 'unavailable') transportObservation = undefined;
    },
    observeResponse(response, { controlledStream }) {
      responseCount++;
      if (responseCount > 1) {
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
      const contentAt = elapsed(at);
      if (lastContentAt !== undefined) {
        const gap = Math.max(0, at - lastContentAt);
        const bucket = gapBucket(gap);
        gapBuckets[bucket] = gapBuckets[bucket]! + 1;
        gapCount++;
        if (bucket === GAP_BUCKET_UPPER_BOUNDS.length) overflowMax = Math.max(overflowMax, gap);
      }
      lastContentAt = at;
      return contentAt;
    },
    snapshot() {
      const raw = responseCount === 1;
      const contentGapP95Ms = gapCount === 0 ? undefined : gapP95(gapBuckets, gapCount, overflowMax);
      return {
        ...(transportObservation === undefined ? {} : { transportObservation }),
        ...(raw && upstreamHeadersMs !== undefined ? { upstreamHeadersMs } : {}),
        ...(raw && firstUpstreamByteMs !== undefined ? { firstUpstreamByteMs } : {}),
        ...(raw && firstSseEventMs !== undefined ? { firstSseEventMs } : {}),
        ...(contentGapP95Ms === undefined ? {} : { contentGapP95Ms }),
        ...(raw && maxSseFramesPerRead !== undefined ? { maxSseFramesPerRead } : {}),
        ...(raw && contentEncoding !== undefined ? { contentEncoding } : {}),
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

function normalizeContentEncoding(value: string | null): ContentEncoding {
  const encodings = (value ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  if (encodings.length === 0) return 'identity';
  if (encodings.length > 1) return 'multiple';
  const encoding = encodings[0];
  return encoding === 'identity' ||
    encoding === 'gzip' ||
    encoding === 'deflate' ||
    encoding === 'br' ||
    encoding === 'zstd'
    ? encoding
    : 'other';
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
