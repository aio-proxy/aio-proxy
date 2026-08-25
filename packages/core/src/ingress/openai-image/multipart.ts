import { RequestBodyTooLargeError } from '../../protocol/request';
import { parseOpenAIImageGenerations, type OpenAIImageRequest, type OpenAIImageUpload } from './openai-image';

export const EDITS_MULTIPART_ENCODED_LIMIT = 851_048_559;
export const EDITS_MULTIPART_PER_FILE_LIMIT = 50_000_000;
export const EDITS_MULTIPART_AGGREGATE_LIMIT = 849_999_983;
export const EDITS_MULTIPART_NON_FILE_LIMIT = 1_048_576;
export const EDITS_MULTIPART_MAX_IMAGES = 16;
export const EDITS_MULTIPART_MAX_MASKS = 1;

const TEXT_DECODER = new TextDecoder();
const CRLF_CRLF = Uint8Array.from([13, 10, 13, 10]);

const OPTIONAL_NUMBER_FIELDS = ['n', 'output_compression', 'partial_images'] as const;
const OPTIONAL_STRING_FIELDS = [
  'size',
  'quality',
  'response_format',
  'output_format',
  'background',
  'moderation',
  'style',
  'user',
] as const;

export function assertEditsMultipartCounters(input: {
  readonly imageCount?: number;
  readonly maskCount?: number;
  readonly fileByteLength?: number;
  readonly aggregateDecoded?: number;
  readonly nonFileFormBytes?: number;
}): void {
  if ((input.imageCount ?? 0) > EDITS_MULTIPART_MAX_IMAGES) throw tooLarge();
  if ((input.maskCount ?? 0) > EDITS_MULTIPART_MAX_MASKS) throw tooLarge();
  if ((input.fileByteLength ?? 0) >= EDITS_MULTIPART_PER_FILE_LIMIT) throw tooLarge();
  if ((input.aggregateDecoded ?? 0) > EDITS_MULTIPART_AGGREGATE_LIMIT) throw tooLarge();
  if ((input.nonFileFormBytes ?? 0) > EDITS_MULTIPART_NON_FILE_LIMIT) throw tooLarge();
}

export async function readEditsMultipartBody(raw: Request): Promise<Uint8Array> {
  return readEncodedBytes(raw, EDITS_MULTIPART_ENCODED_LIMIT);
}

export async function parseOpenAIImageEditsMultipart(raw: Request): Promise<OpenAIImageRequest> {
  const contentType = raw.headers.get('content-type') ?? '';
  const boundary = multipartBoundary(contentType);
  if (boundary === undefined) throw new SyntaxError('Invalid OpenAI Images multipart request');
  const bytes = await readEncodedBytes(raw, EDITS_MULTIPART_ENCODED_LIMIT);
  const { fields, uploads, maskUpload } = parseMultipartEdits(bytes, boundary);
  if (uploads.length === 0) throw new SyntaxError('Invalid OpenAI Images multipart request');
  return {
    ...parseOpenAIImageGenerations(generationsInputFromFields(fields)),
    uploads,
    ...(maskUpload === undefined ? {} : { maskUpload }),
  };
}

function parseMultipartEdits(
  bytes: Uint8Array,
  boundary: string,
): {
  readonly fields: Record<string, string>;
  readonly uploads: OpenAIImageUpload[];
  readonly maskUpload?: OpenAIImageUpload;
} {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const nextDelimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  let offset = indexOfBytes(bytes, delimiter, 0);
  if (offset === -1) throw new SyntaxError('Invalid OpenAI Images multipart request');
  offset += delimiter.length;

  const fields: Record<string, string> = {};
  const uploads: OpenAIImageUpload[] = [];
  let maskUpload: OpenAIImageUpload | undefined;
  let nonFileFormBytes = 0;
  let aggregateDecoded = 0;

  while (offset < bytes.byteLength) {
    if (bytes[offset] === 45 && bytes[offset + 1] === 45) break;
    if (bytes[offset] === 13 && bytes[offset + 1] === 10) offset += 2;
    const headerEnd = indexOfBytes(bytes, CRLF_CRLF, offset);
    if (headerEnd === -1) throw new SyntaxError('Invalid OpenAI Images multipart request');
    const headers = TEXT_DECODER.decode(bytes.subarray(offset, headerEnd));
    const bodyStart = headerEnd + 4;
    const bodyEnd = indexOfBytes(bytes, nextDelimiter, bodyStart);
    if (bodyEnd === -1) throw new SyntaxError('Invalid OpenAI Images multipart request');
    const body = bytes.subarray(bodyStart, bodyEnd);
    const name = normalizeFieldName(dispositionName(headers));
    if (name === 'image') {
      assertEditsMultipartCounters({ imageCount: uploads.length + 1, fileByteLength: body.byteLength });
      aggregateDecoded += body.byteLength;
      assertEditsMultipartCounters({ aggregateDecoded });
      uploads.push({ data: body.slice(), byteLength: body.byteLength });
    } else if (name === 'mask') {
      assertEditsMultipartCounters({
        maskCount: (maskUpload === undefined ? 0 : 1) + 1,
        fileByteLength: body.byteLength,
      });
      aggregateDecoded += body.byteLength;
      assertEditsMultipartCounters({ aggregateDecoded });
      maskUpload = { data: body.slice(), byteLength: body.byteLength };
    } else if (name !== undefined) {
      nonFileFormBytes += body.byteLength;
      assertEditsMultipartCounters({ nonFileFormBytes });
      fields[name] = TEXT_DECODER.decode(body);
    }
    offset = bodyEnd + 2 + delimiter.length;
  }

  return { fields, uploads, ...(maskUpload === undefined ? {} : { maskUpload }) };
}

function generationsInputFromFields(fields: Record<string, string>): Record<string, unknown> {
  const stream = parseOptionalBoolean(fields['stream']);
  const model = fields['model'];
  const input: Record<string, unknown> = {
    ...(model === undefined ? {} : { model }),
    prompt: fields['prompt'],
    ...(stream === undefined ? {} : { stream }),
  };
  for (const key of OPTIONAL_NUMBER_FIELDS) {
    const value = parseOptionalNumber(fields[key]);
    if (value !== undefined) input[key] = value;
  }
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (fields[key] !== undefined) input[key] = fields[key];
  }
  return input;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function normalizeFieldName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return name.endsWith('[]') ? name.slice(0, -2) : name;
}

function dispositionName(headers: string): string | undefined {
  const disposition = headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-disposition:'));
  if (disposition === undefined) return undefined;
  const quoted = /(?:^|;\s*)name="([^"]*)"/iu.exec(disposition);
  if (quoted?.[1] !== undefined) return quoted[1];
  return /(?:^|;\s*)name=([^;\s]+)/iu.exec(disposition)?.[1];
}

function multipartBoundary(contentType: string): string | undefined {
  const match = /(?:^|;\s*)boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2]?.trim();
  return boundary === undefined || boundary === '' ? undefined : boundary;
}

async function readEncodedBytes(raw: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = raw.clone().body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        const error = tooLarge();
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start: number): number {
  if (needle.byteLength === 0) return start;
  const last = haystack.byteLength - needle.byteLength;
  for (let index = start; index <= last; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function tooLarge(): RequestBodyTooLargeError {
  return new RequestBodyTooLargeError('Request body too large');
}
