import { withAbortAndIdle } from '../../protocol/request';
import { EDITS_MULTIPART_ENCODED_LIMIT, assertEditsMultipartCounters, tooLarge } from './multipart-counters';
import { type OpenAIImageUpload } from './openai-image';

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const CRLF_CRLF = Buffer.from('\r\n\r\n');

export type ParsedEditsMultipart = {
  readonly fields: Record<string, string>;
  readonly uploads: OpenAIImageUpload[];
  readonly maskUpload?: OpenAIImageUpload;
};

type PartKind = 'image' | 'mask' | 'field';

type OpenPart = {
  readonly kind: PartKind;
  readonly fieldName?: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly chunks: Uint8Array[];
  length: number;
};

export async function parseMultipartStream(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  signal?: AbortSignal,
  idleTimeoutMs = 600_000,
): Promise<ParsedEditsMultipart> {
  const reader = body?.getReader();
  if (reader === undefined) throw syntax();

  const firstBoundary = Buffer.from(TEXT_ENCODER.encode(`--${boundary}`));
  const nextBoundary = Buffer.from(TEXT_ENCODER.encode(`\r\n--${boundary}`));
  const window = new ByteWindow();
  let state: 'preamble' | 'afterBoundary' | 'headers' | 'body' | 'done' = 'preamble';
  let encoded = 0;
  let framing = 0;
  let aggregateDecoded = 0;
  let imageCount = 0;
  let maskCount = 0;
  let current: OpenPart | undefined;
  const fields: Record<string, string> = {};
  const uploads: OpenAIImageUpload[] = [];
  let maskUpload: OpenAIImageUpload | undefined;
  const readChunk = () =>
    readEncodedChunk(
      reader,
      window,
      () => encoded,
      (total) => {
        encoded = total;
      },
      signal,
      idleTimeoutMs,
    );

  const addFraming = (bytes: number): void => {
    framing += bytes;
    assertEditsMultipartCounters({ nonFileFormBytes: framing });
  };

  const appendPartBytes = (part: OpenPart, bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return;
    part.length += bytes.byteLength;
    if (part.kind === 'image' || part.kind === 'mask') {
      assertEditsMultipartCounters({ fileByteLength: part.length });
      part.chunks.push(bytes.slice());
      return;
    }
    addFraming(bytes.byteLength);
    if (part.fieldName !== undefined) part.chunks.push(bytes.slice());
  };

  const finishPart = (part: OpenPart): void => {
    if (part.kind === 'image' || part.kind === 'mask') {
      aggregateDecoded += part.length;
      assertEditsMultipartCounters({ aggregateDecoded });
      const upload = toUpload(part);
      if (part.kind === 'image') uploads.push(upload);
      else maskUpload = upload;
      return;
    }
    if (part.fieldName !== undefined) fields[part.fieldName] = TEXT_DECODER.decode(concatChunks(part.chunks));
  };

  try {
    while (state !== 'done') {
      if (state === 'preamble') {
        const index = window.indexOf(firstBoundary);
        if (index === -1) {
          const flushed = window.flushExcept(window.delimiterOverlap(firstBoundary));
          if (flushed !== undefined) addFraming(flushed.byteLength);
          await readChunk();
          continue;
        }
        const after = index + firstBoundary.byteLength;
        if (window.byteLength < after + 2) {
          if (index > 0) addFraming(window.consume(index).byteLength);
          await readChunk();
          continue;
        }
        if (!isLineStart(window, index) || !isBoundarySuffix(window.bytes().subarray(after, after + 2))) {
          addFraming(window.consume(index + 1).byteLength);
          continue;
        }
        addFraming(index + firstBoundary.byteLength);
        window.consume(index + firstBoundary.byteLength);
        state = 'afterBoundary';
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
          state = 'done';
          continue;
        }
        if (head[0] === 13 && head[1] === 10) {
          addFraming(2);
          window.consume(2);
          state = 'headers';
          continue;
        }
        throw syntax();
      }

      if (state === 'headers') {
        const index = window.indexOf(CRLF_CRLF);
        if (index === -1) {
          assertEditsMultipartCounters({ nonFileFormBytes: framing + window.byteLength });
          await readChunk();
          continue;
        }
        const headerBytes = window.consume(index + 4);
        addFraming(headerBytes.byteLength);
        current = startPart(
          TEXT_DECODER.decode(headerBytes.subarray(0, index)),
          () => {
            imageCount += 1;
            assertEditsMultipartCounters({ imageCount });
          },
          () => {
            maskCount += 1;
            assertEditsMultipartCounters({ maskCount });
          },
        );
        state = 'body';
        continue;
      }

      if (current === undefined) throw syntax();
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
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return { fields, uploads, ...(maskUpload === undefined ? {} : { maskUpload }) };
}

async function readEncodedChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  window: ByteWindow,
  encoded: () => number,
  setEncoded: (total: number) => void,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<void> {
  const next = await withAbortAndIdle(reader.read(), signal, idleTimeoutMs);
  if (next.done) throw syntax();
  const total = encoded() + next.value.byteLength;
  if (total > EDITS_MULTIPART_ENCODED_LIMIT) throw tooLarge();
  setEncoded(total);
  window.append(next.value);
}

function startPart(headers: string, onImage: () => void, onMask: () => void): OpenPart {
  const rawName = dispositionToken(headers, 'name');
  const filename = dispositionToken(headers, 'filename');
  const mediaType = contentType(headers);
  const name = normalizeFieldName(rawName);
  if (name === 'image') {
    onImage();
    return { kind: 'image', fieldName: rawName, filename, mediaType, chunks: [], length: 0 };
  }
  if (name === 'mask') {
    onMask();
    return { kind: 'mask', fieldName: rawName, filename, mediaType, chunks: [], length: 0 };
  }
  return { kind: 'field', fieldName: rawName, filename, mediaType, chunks: [], length: 0 };
}

function toUpload(part: OpenPart): OpenAIImageUpload {
  return {
    data: concatChunks(part.chunks),
    byteLength: part.length,
    ...(part.fieldName === undefined ? {} : { fieldName: part.fieldName }),
    ...(part.filename === undefined ? {} : { filename: part.filename }),
    ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
  };
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

function syntax(): SyntaxError {
  return new SyntaxError('Invalid OpenAI Images multipart request');
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
