import type { Transform } from "node:stream";

import { constants, createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from "node:zlib";

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

const decoderDefinitions = {
  gzip: { create: createGunzip, flush: constants.Z_SYNC_FLUSH },
  deflate: { create: createInflate, flush: constants.Z_SYNC_FLUSH },
  br: { create: createBrotliDecompress, flush: constants.BROTLI_OPERATION_FLUSH },
  zstd: { create: createZstdDecompress, flush: constants.ZSTD_e_flush },
} as const;

type SupportedEncoding = keyof typeof decoderDefinitions;

function isSupportedEncoding(value: string): value is SupportedEncoding {
  return Object.hasOwn(decoderDefinitions, value);
}

function toUint8Array(chunk: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function runStageOperation(
  stage: DecoderStage,
  start: (settle: (error?: Error | null) => void) => void,
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve) => {
    let settled = false;
    const onData = (chunk: Buffer | Uint8Array) => {
      chunks.push(toUint8Array(chunk));
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stage.off("data", onData);
      // Keep an error listener so late zlib/transform errors are not unhandled.
      stage.on("error", () => undefined);
      stage.off("error", onError);
      resolve(error === undefined || error === null ? { chunks } : { chunks, error });
    };
    const onError = (error: Error) => {
      finish(error);
    };
    stage.on("data", onData);
    stage.on("error", onError);
    start((error) => {
      finish(error);
    });
  });
}

function writeStage(stage: DecoderStage, bytes: Uint8Array): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  if (stage.destroyed) {
    return Promise.resolve({ chunks: [] });
  }
  return runStageOperation(stage, (settle) => {
    stage.write(Buffer.from(bytes), settle);
  });
}

function flushStage(stage: DecoderStage, flush: number): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  if (stage.destroyed) {
    return Promise.resolve({ chunks: [] });
  }
  return runStageOperation(stage, (settle) => {
    stage.flush(flush, settle);
  });
}

function endStage(stage: DecoderStage): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  if (stage.destroyed) {
    return Promise.resolve({ chunks: [] });
  }
  // Settle on close: zlib may emit error after the end() callback (e.g. truncated gzip).
  return runStageOperation(stage, (settle) => {
    stage.once("close", () => {
      settle(null);
    });
    if (stage.writableEnded) {
      if (stage.closed) settle(null);
      return;
    }
    stage.end();
  });
}

async function feedStage(
  stage: DecoderStage,
  flush: number,
  inputs: readonly Uint8Array[],
  mode: "flush" | "end",
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  const output: Uint8Array[] = [];
  let error: unknown;

  for (const bytes of inputs) {
    if (bytes.byteLength === 0) continue;
    const written = await writeStage(stage, bytes);
    output.push(...written.chunks);
    if (written.error !== undefined) {
      error = written.error;
      break;
    }
  }

  if (error === undefined) {
    const finished = mode === "end" ? await endStage(stage) : await flushStage(stage, flush);
    output.push(...finished.chunks);
    if (finished.error !== undefined) error = finished.error;
  }

  return error === undefined ? { chunks: output } : { chunks: output, error };
}

async function decodeThroughStages(
  stages: readonly { stage: DecoderStage; flush: number }[],
  input: Uint8Array,
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  let current: readonly Uint8Array[] = [input];
  let firstError: unknown;

  for (const { stage, flush } of stages) {
    const result = await feedStage(stage, flush, current, "flush");
    current = result.chunks;
    if (result.error !== undefined && firstError === undefined) firstError = result.error;
    // Keep pushing already-emitted bytes through later stages after an error.
  }

  return firstError === undefined ? { chunks: [...current] } : { chunks: [...current], error: firstError };
}

async function finalizeThroughStages(
  stages: readonly { stage: DecoderStage; flush: number }[],
): Promise<{ chunks: Uint8Array[]; error?: unknown }> {
  let current: readonly Uint8Array[] = [];
  let firstError: unknown;

  for (const { stage, flush } of stages) {
    const result = await feedStage(stage, flush, current, "end");
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
  const stages = encodings
    .slice()
    .reverse()
    .map((encoding) => {
      const definition = decoderDefinitions[encoding];
      return {
        stage: definition.create() as DecoderStage,
        flush: definition.flush,
      };
    });

  const sourceReader = source.getReader();
  let cancelled = false;
  let sourceCancelled = false;
  let stagesDestroyed = false;

  const destroyStages = () => {
    if (stagesDestroyed) return;
    stagesDestroyed = true;
    for (const { stage } of stages) {
      if (!stage.destroyed) {
        // Destroy without an error argument so cancel does not surface spurious stage errors.
        stage.on("error", () => undefined);
        stage.destroy();
      }
    }
  };

  return {
    async read() {
      if (cancelled) {
        return { chunks: [], done: true };
      }

      const encoded = await sourceReader.read();
      if (encoded.done) {
        const result = await finalizeThroughStages(stages);
        return result.error === undefined
          ? { chunks: result.chunks, done: true }
          : { chunks: result.chunks, done: true, error: result.error };
      }

      if (stages.length === 0) {
        return { chunks: [encoded.value], done: false };
      }

      const result = await decodeThroughStages(stages, encoded.value);
      return result.error === undefined
        ? { chunks: result.chunks, done: false }
        : { chunks: result.chunks, done: false, error: result.error };
    },

    async cancel(reason?: unknown) {
      if (cancelled) return;
      cancelled = true;
      if (!sourceCancelled) {
        sourceCancelled = true;
        await sourceReader.cancel(reason);
      }
      destroyStages();
    },
  };
}
