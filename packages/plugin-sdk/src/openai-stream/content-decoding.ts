import type { Transform } from "node:stream";

import * as zlib from "node:zlib";

export type DecodedRead = {
  readonly chunks: readonly Uint8Array[];
  readonly done: boolean;
  readonly error?: unknown;
};

export type ContentDecodedReader = {
  readonly read: () => Promise<DecodedRead>;
  readonly cancel: (reason?: unknown) => Promise<void>;
};

type DecoderStage = Transform & {
  flush(kind: number, callback: (error?: Error | null) => void): void;
  readonly closed?: boolean;
};

type ManagedStage = {
  readonly stage: DecoderStage;
  readonly flush: number;
  pendingError?: unknown;
  activeSettle?: (error?: Error | null) => void;
};

// Lazy zlib lookups so bun:test `mock.module("node:zlib")` can replace codecs after import.
const decoderDefinitions = {
  gzip: { create: () => zlib.createGunzip(), flush: zlib.constants.Z_SYNC_FLUSH },
  deflate: { create: () => zlib.createInflate(), flush: zlib.constants.Z_SYNC_FLUSH },
  br: { create: () => zlib.createBrotliDecompress(), flush: zlib.constants.BROTLI_OPERATION_FLUSH },
  zstd: { create: () => zlib.createZstdDecompress(), flush: zlib.constants.ZSTD_e_flush },
} as const;

type SupportedEncoding = keyof typeof decoderDefinitions;

function isSupportedEncoding(value: string): value is SupportedEncoding {
  return Object.hasOwn(decoderDefinitions, value);
}

function toUint8Array(chunk: ArrayBufferView): Uint8Array {
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function createManagedStage(encoding: SupportedEncoding, onIdleError: (error: unknown) => void): ManagedStage {
  const definition = decoderDefinitions[encoding];
  const managed: ManagedStage = {
    stage: definition.create() as DecoderStage,
    flush: definition.flush,
  };
  // One persistent listener: records between-op errors and settles any active operation.
  managed.stage.on("error", (error: Error) => {
    if (managed.pendingError === undefined) managed.pendingError = error;
    const settle = managed.activeSettle;
    if (settle === undefined) onIdleError(error);
    else settle(error);
  });
  return managed;
}

function takePendingError(stages: readonly ManagedStage[]): unknown {
  for (const managed of stages) {
    if (managed.pendingError !== undefined) {
      const error = managed.pendingError;
      managed.pendingError = undefined;
      return error;
    }
  }
  return undefined;
}

function runStageOperation(
  managed: ManagedStage,
  start: (settle: (error?: Error | null) => void) => void,
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  const { stage } = managed;
  const chunks: Uint8Array[] = [];
  return new Promise((resolve) => {
    let settled = false;
    const onData = (chunk: unknown) => {
      chunks.push(toUint8Array(chunk as ArrayBufferView));
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      delete managed.activeSettle;
      stage.off("data", onData);
      const pending = managed.pendingError;
      if (pending !== undefined) managed.pendingError = undefined;
      const combined = error === undefined || error === null ? pending : error;
      resolve(combined === undefined ? { chunks } : { chunks, error: combined });
    };
    stage.on("data", onData);
    managed.activeSettle = finish;
    start(finish);
  });
}

function writeStage(managed: ManagedStage, bytes: Uint8Array): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  if (managed.stage.destroyed) return Promise.resolve({ chunks: [] });
  return runStageOperation(managed, (settle) => {
    // node:zlib Transform accepts Uint8Array; avoid Buffer so library DTS builds without Node types.
    managed.stage.write(bytes as never, settle);
  });
}

function flushStage(managed: ManagedStage): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  if (managed.stage.destroyed) {
    return Promise.resolve({ chunks: [] });
  }
  return runStageOperation(managed, (settle) => {
    managed.stage.flush(managed.flush, settle);
  });
}

function endStage(managed: ManagedStage): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  if (managed.stage.destroyed) {
    return Promise.resolve({ chunks: [] });
  }
  // Settle on close: zlib may emit error after the end() callback (e.g. truncated gzip).
  return runStageOperation(managed, (settle) => {
    managed.stage.once("close", () => settle(null));
    if (managed.stage.writableEnded) {
      if (managed.stage.closed) settle(null);
      return;
    }
    managed.stage.end();
  });
}

async function feedStage(
  managed: ManagedStage,
  inputs: readonly Uint8Array[],
  mode: "flush" | "end",
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  const output: Uint8Array[] = [];
  let error: unknown;

  for (const bytes of inputs) {
    if (bytes.byteLength === 0) continue;
    const written = await writeStage(managed, bytes);
    output.push(...written.chunks);
    if (written.error !== undefined) {
      error = written.error;
      break;
    }
  }

  if (error === undefined) {
    const finished = mode === "end" ? await endStage(managed) : await flushStage(managed);
    output.push(...finished.chunks);
    if (finished.error !== undefined) error = finished.error;
  }

  return error === undefined ? { chunks: output } : { chunks: output, error };
}

async function decodeThroughStages(
  stages: readonly ManagedStage[],
  input: Uint8Array,
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  let current: readonly Uint8Array[] = [input];
  let firstError: unknown;

  for (const managed of stages) {
    const result = await feedStage(managed, current, "flush");
    current = result.chunks;
    if (result.error !== undefined && firstError === undefined) firstError = result.error;
  }

  return firstError === undefined ? { chunks: [...current] } : { chunks: [...current], error: firstError };
}

async function finalizeThroughStages(
  stages: readonly ManagedStage[],
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  let current: readonly Uint8Array[] = [];
  let firstError: unknown;

  for (const managed of stages) {
    const result = await feedStage(managed, current, "end");
    current = result.chunks;
    if (result.error !== undefined && firstError === undefined) firstError = result.error;
  }

  return firstError === undefined ? { chunks: [...current] } : { chunks: [...current], error: firstError };
}

export function createContentDecodedReader(
  source: ReadableStream<Uint8Array>,
  contentEncoding: string | null,
): ContentDecodedReader {
  const encodingTokens = (contentEncoding ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "" && value !== "identity");

  const encodings: SupportedEncoding[] = [];
  for (const encoding of encodingTokens) {
    if (!isSupportedEncoding(encoding)) {
      throw new Error(`Unsupported Content-Encoding: ${encoding}`);
    }
    encodings.push(encoding);
  }

  // Decode in reverse of Content-Encoding application order (toReversed-equivalent).
  let activeReadError: ((error: unknown) => void) | undefined;
  const stages = encodings
    .slice()
    .reverse()
    .map((encoding) => createManagedStage(encoding, (error) => activeReadError?.(error)));

  const sourceReader = source.getReader();
  let cancelled = false;
  let sourceCancelled = false;
  let stagesDestroyed = false;

  const destroyStages = () => {
    if (stagesDestroyed) return;
    stagesDestroyed = true;
    for (const { stage } of stages) {
      if (!stage.destroyed) stage.destroy();
    }
  };

  const cleanup = async (reason?: unknown) => {
    if (cancelled) {
      destroyStages();
      return;
    }
    cancelled = true;
    destroyStages();
    if (!sourceCancelled) {
      sourceCancelled = true;
      try {
        await sourceReader.cancel(reason);
      } catch {
        // Source cancellation is best-effort after local decoder cleanup.
      }
    }
  };

  return {
    async read() {
      if (cancelled) {
        return { chunks: [], done: true };
      }

      const pendingBefore = takePendingError(stages);
      if (pendingBefore !== undefined) {
        void cleanup(pendingBefore);
        return { chunks: [], done: false, error: pendingBefore };
      }

      let decoderFailed = false;
      const decoderFailure = new Promise<never>((_resolve, reject) => {
        activeReadError = (error) => {
          decoderFailed = true;
          reject(error);
        };
      });
      let encoded;
      try {
        encoded = await Promise.race([sourceReader.read(), decoderFailure]);
      } catch (error) {
        activeReadError = undefined;
        void cleanup(error);
        return { chunks: [], done: !decoderFailed, error };
      }
      activeReadError = undefined;

      const pendingAfter = takePendingError(stages);
      if (pendingAfter !== undefined) {
        void cleanup(pendingAfter);
        return { chunks: [], done: false, error: pendingAfter };
      }

      if (encoded.done) {
        const result = await finalizeThroughStages(stages);
        if (result.error !== undefined) void cleanup(result.error);
        return result.error === undefined
          ? { chunks: result.chunks, done: true }
          : { chunks: result.chunks, done: true, error: result.error };
      }

      if (stages.length === 0) return { chunks: [encoded.value], done: false };

      const result = await decodeThroughStages(stages, encoded.value);
      if (result.error !== undefined) void cleanup(result.error);
      return result.error === undefined
        ? { chunks: result.chunks, done: false }
        : { chunks: result.chunks, done: false, error: result.error };
    },

    cancel: cleanup,
  };
}
