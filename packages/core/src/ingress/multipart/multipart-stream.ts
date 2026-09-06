import { RequestBodyTooLargeError, withAbortAndIdle } from '../../protocol/request';

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const CRLF_CRLF = Buffer.from('\r\n\r\n');

export type MultipartUpload = {
  readonly data: Uint8Array;
  readonly byteLength: number;
  readonly fieldName?: string;
  readonly filename?: string;
  readonly mediaType?: string;
};

export type MultipartLimits = {
  readonly perFile: number;
  readonly aggregate: number;
  readonly nonFile: number;
  /** Cap on repeatable file parts. Singleton file fields are bounded at one each and excluded. */
  readonly maxFiles: number;
};

export type MultipartStreamSpec = {
  /** Form field names whose parts are read as files rather than decoded as text. */
  readonly fileFields: ReadonlySet<string>;
  /** File fields that may appear at most once (OpenAI `mask`, audio `file`). */
  readonly singletonFileFields?: ReadonlySet<string>;
  readonly limits: MultipartLimits;
  readonly syntaxError: () => Error;
};

export type ParsedMultipart = {
  readonly fields: Record<string, string>;
  readonly uploads: readonly MultipartUpload[];
  readonly namedUploads: Readonly<Record<string, MultipartUpload>>;
};

type PartKind = 'file' | 'field';

type OpenPart = {
  readonly kind: PartKind;
  readonly name?: string;
  readonly fieldName?: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly chunks: Uint8Array[];
  length: number;
};

export function multipartBoundary(contentType: string): string | undefined {
  const match = /(?:^|;\s*)boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export async function parseMultipartStream(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  spec: MultipartStreamSpec,
  signal?: AbortSignal,
  idleTimeoutMs = 600_000,
): Promise<ParsedMultipart> {
  const reader = body?.getReader();
  if (reader === undefined) throw spec.syntaxError();

  const firstBoundary = Buffer.from(TEXT_ENCODER.encode(`--${boundary}`));
  const nextBoundary = Buffer.from(TEXT_ENCODER.encode(`\r\n--${boundary}`));
  // The widest envelope a spec can legitimately fill: every file byte plus every
  // framing byte. Anything past it is padding, so it is refused without buffering.
  const encodedLimit = spec.limits.aggregate + spec.limits.nonFile;
  const window = new ByteWindow();
  let state: 'preamble' | 'afterBoundary' | 'headers' | 'body' | 'done' = 'preamble';
  let encoded = 0;
  let nonFileFormBytes = 0;
  let aggregateDecoded = 0;
  let current: OpenPart | undefined;
  const fileCounts = new Map<string, number>();
  const fields: Record<string, string> = {};
  const uploads: MultipartUpload[] = [];
  const namedUploads: Record<string, MultipartUpload> = {};
  const readChunk = () =>
    readEncodedChunk(
      reader,
      window,
      () => encoded,
      (total) => {
        encoded = total;
      },
      { encodedLimit, syntaxError: spec.syntaxError, signal, idleTimeoutMs },
    );

  const addFraming = (bytes: number): void => {
    nonFileFormBytes += bytes;
    if (nonFileFormBytes > spec.limits.nonFile) throw tooLarge();
  };

  const appendPartBytes = (part: OpenPart, bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return;
    part.length += bytes.byteLength;
    if (part.kind === 'file') {
      if (part.length > spec.limits.perFile) throw tooLarge();
      // Copy: window slices alias a buffer the reader keeps growing and dropping.
      part.chunks.push(bytes.slice());
      return;
    }
    addFraming(bytes.byteLength);
    if (part.name !== undefined) part.chunks.push(bytes.slice());
  };

  const finishPart = (part: OpenPart): void => {
    if (part.kind === 'file') {
      aggregateDecoded += part.length;
      if (aggregateDecoded > spec.limits.aggregate) throw tooLarge();
      const upload = toUpload(part);
      uploads.push(upload);
      if (part.name !== undefined) namedUploads[part.name] = upload;
      return;
    }
    if (part.name !== undefined) fields[part.name] = TEXT_DECODER.decode(concatChunks(part.chunks));
  };

  try {
    while (state !== 'done') {
      if (state === 'preamble') {
        state = await scanPreamble(window, firstBoundary, addFraming, readChunk);
        continue;
      }

      if (state === 'afterBoundary') {
        if (window.byteLength < 2) {
          await readChunk();
          continue;
        }
        const head = window.bytes();
        if (head[0] === 45 && head[1] === 45) {
          addFraming(2);
          window.consume(2);
          addFraming(window.byteLength);
          window.consume(window.byteLength);
          state = 'done';
          continue;
        }
        if (head[0] === 13 && head[1] === 10) {
          addFraming(2);
          window.consume(2);
          state = 'headers';
          continue;
        }
        throw spec.syntaxError();
      }

      if (state === 'headers') {
        const index = window.indexOf(CRLF_CRLF);
        if (index === -1) {
          if (nonFileFormBytes + window.byteLength > spec.limits.nonFile) throw tooLarge();
          await readChunk();
          continue;
        }
        const headerBytes = window.consume(index + 4);
        addFraming(headerBytes.byteLength);
        current = startPart(TEXT_DECODER.decode(headerBytes.subarray(0, index)), spec, fileCounts);
        state = 'body';
        continue;
      }

      if (current === undefined) throw spec.syntaxError();
      const index = window.indexOf(nextBoundary);
      if (index === -1) {
        const flushed = window.flushExcept(window.delimiterOverlap(nextBoundary));
        if (flushed !== undefined) appendPartBytes(current, flushed);
        await readChunk();
        continue;
      }
      const after = index + nextBoundary.byteLength;
      if (window.byteLength < after + 2) {
        if (index > 0) appendPartBytes(current, window.consume(index));
        await readChunk();
        continue;
      }
      if (!isBoundarySuffix(window.bytes().subarray(after, after + 2))) {
        appendPartBytes(current, window.consume(index + 1));
        continue;
      }
      appendPartBytes(current, window.consume(index));
      finishPart(current);
      current = undefined;
      addFraming(nextBoundary.byteLength);
      window.consume(nextBoundary.byteLength);
      state = 'afterBoundary';
    }
    await drainEncodedRemainder(reader, encoded, addFraming, { encodedLimit, signal, idleTimeoutMs });
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return { fields, uploads, namedUploads };
}

type EncodedReadOptions = {
  readonly encodedLimit: number;
  readonly signal: AbortSignal | undefined;
  readonly idleTimeoutMs: number;
};

async function readEncodedChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  window: ByteWindow,
  encoded: () => number,
  setEncoded: (total: number) => void,
  options: EncodedReadOptions & { readonly syntaxError: () => Error },
): Promise<void> {
  const next = await withAbortAndIdle(reader.read(), options.signal, options.idleTimeoutMs);
  if (next.done) throw options.syntaxError();
  const total = encoded() + next.value.byteLength;
  if (total > options.encodedLimit) throw tooLarge();
  setEncoded(total);
  window.append(next.value);
}

async function scanPreamble(
  window: ByteWindow,
  firstBoundary: Buffer,
  addFraming: (bytes: number) => void,
  readChunk: () => Promise<void>,
): Promise<'preamble' | 'afterBoundary'> {
  const index = window.indexOf(firstBoundary);
  if (index === -1) {
    const overlap = window.delimiterOverlap(firstBoundary);
    const prefixKeep = overlap === 0 ? 0 : Math.min(2, window.byteLength - overlap);
    const flushed = window.flushExcept(overlap + prefixKeep);
    if (flushed !== undefined) addFraming(flushed.byteLength);
    await readChunk();
    return 'preamble';
  }
  const after = index + firstBoundary.byteLength;
  if (window.byteLength < after + 2) {
    const keepPrefix = index >= 2 ? 2 : index;
    if (index > keepPrefix) addFraming(window.consume(index - keepPrefix).byteLength);
    await readChunk();
    return 'preamble';
  }
  if (!isLineStart(window, index) || !isBoundarySuffix(window.bytes().subarray(after, after + 2))) {
    addFraming(window.consume(index + 1).byteLength);
    return 'preamble';
  }
  addFraming(index + firstBoundary.byteLength);
  window.consume(index + firstBoundary.byteLength);
  return 'afterBoundary';
}

async function drainEncodedRemainder(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  encoded: number,
  addFraming: (bytes: number) => void,
  options: EncodedReadOptions,
): Promise<void> {
  for (;;) {
    const next = await withAbortAndIdle(reader.read(), options.signal, options.idleTimeoutMs);
    if (next.done) return;
    const total = encoded + next.value.byteLength;
    if (total > options.encodedLimit) throw tooLarge();
    encoded = total;
    addFraming(next.value.byteLength);
  }
}

function startPart(headers: string, spec: MultipartStreamSpec, counts: Map<string, number>): OpenPart {
  const rawName = dispositionToken(headers, 'name');
  const filename = dispositionToken(headers, 'filename');
  const mediaType = contentType(headers);
  const name = normalizeFieldName(rawName);
  const base = { name, fieldName: rawName, filename, mediaType, chunks: [], length: 0 };
  if (name === undefined || !spec.fileFields.has(name)) return { ...base, kind: 'field' };
  const seen = (counts.get(name) ?? 0) + 1;
  counts.set(name, seen);
  if (spec.singletonFileFields?.has(name) === true) {
    if (seen > 1) throw tooLarge();
  } else if (repeatableFileCount(counts, spec) > spec.limits.maxFiles) {
    throw tooLarge();
  }
  return { ...base, kind: 'file' };
}

function repeatableFileCount(counts: Map<string, number>, spec: MultipartStreamSpec): number {
  let total = 0;
  for (const [name, count] of counts) {
    if (spec.singletonFileFields?.has(name) !== true) total += count;
  }
  return total;
}

function toUpload(part: OpenPart): MultipartUpload {
  return {
    data: concatChunks(part.chunks),
    byteLength: part.length,
    ...(part.fieldName === undefined ? {} : { fieldName: part.fieldName }),
    ...(part.filename === undefined ? {} : { filename: part.filename }),
    ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
  };
}

function tooLarge(): RequestBodyTooLargeError {
  return new RequestBodyTooLargeError('Request body too large');
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeFieldName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return name.endsWith('[]') ? name.slice(0, -2) : name;
}

function contentType(headers: string): string | undefined {
  const line = headers.split('\r\n').find((entry) => entry.toLowerCase().startsWith('content-type:'));
  if (line === undefined) return undefined;
  const value = line.slice('content-type:'.length).trim().split(';')[0]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function dispositionToken(headers: string, token: 'name' | 'filename'): string | undefined {
  const disposition = headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-disposition:'));
  if (disposition === undefined) return undefined;
  const quoted = new RegExp(`(?:^|;\\s*)${token}="([^"]*)"`, 'iu').exec(disposition);
  if (quoted?.[1] !== undefined) return quoted[1];
  return new RegExp(`(?:^|;\\s*)${token}=([^;\\s]+)`, 'iu').exec(disposition)?.[1];
}

function isLineStart(window: ByteWindow, index: number): boolean {
  if (index === 0) return true;
  if (index < 2) return false;
  const bytes = window.bytes();
  return bytes[index - 2] === 13 && bytes[index - 1] === 10;
}

function isBoundarySuffix(bytes: Uint8Array): boolean {
  return (bytes[0] === 45 && bytes[1] === 45) || (bytes[0] === 13 && bytes[1] === 10);
}

class ByteWindow {
  private buffer = Buffer.alloc(0);

  get byteLength(): number {
    return this.buffer.byteLength;
  }

  append(chunk: Uint8Array): void {
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
  }

  bytes(): Buffer {
    return this.buffer;
  }

  indexOf(needle: Uint8Array): number {
    return this.buffer.indexOf(needle);
  }

  consume(count: number): Buffer {
    const taken = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return taken;
  }

  flushExcept(keep: number): Buffer | undefined {
    if (this.buffer.byteLength <= keep) return undefined;
    return this.consume(this.buffer.byteLength - keep);
  }

  delimiterOverlap(needle: Uint8Array): number {
    const max = Math.min(this.buffer.byteLength, Math.max(0, needle.byteLength - 1));
    for (let keep = max; keep > 0; keep -= 1) {
      let matched = true;
      const start = this.buffer.byteLength - keep;
      for (let offset = 0; offset < keep; offset += 1) {
        if (this.buffer[start + offset] !== needle[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) return keep;
    }
    return 0;
  }
}
