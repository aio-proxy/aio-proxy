import { decodedRequestStream, type RequestBodyLimits } from '../../protocol/request';
import {
  acquireMultipartSlot,
  multipartBoundary,
  type MultipartSpool,
  type MultipartStreamSpec,
  parseMultipartStream,
  retainMultipartSpool,
  spoolMultipartBody,
} from '../multipart';
import {
  EDITS_MULTIPART_AGGREGATE_LIMIT,
  EDITS_MULTIPART_ENCODED_LIMIT,
  EDITS_MULTIPART_MAX_IMAGES,
  EDITS_MULTIPART_NON_FILE_LIMIT,
  EDITS_MULTIPART_PER_FILE_LIMIT,
} from './multipart-counters';
import { parseOpenAIImageGenerations, type OpenAIImageRequest } from './openai-image';

const MULTIPART_DECODE_LIMITS = Object.freeze({
  encoded: EDITS_MULTIPART_ENCODED_LIMIT,
  decoded: EDITS_MULTIPART_ENCODED_LIMIT,
}) satisfies RequestBodyLimits;

const EDITS_MULTIPART_SPEC: MultipartStreamSpec = {
  fileFields: new Set(['image', 'mask']),
  singletonFileFields: new Set(['mask']),
  limits: {
    // MultipartLimits are inclusive maxima; the official per-file cap is exclusive
    // (OpenAI refuses a file of exactly 50 MB), so the largest accepted size is one less.
    perFile: EDITS_MULTIPART_PER_FILE_LIMIT - 1,
    aggregate: EDITS_MULTIPART_AGGREGATE_LIMIT,
    nonFile: EDITS_MULTIPART_NON_FILE_LIMIT,
    maxFiles: EDITS_MULTIPART_MAX_IMAGES,
  },
  syntaxError: () => new SyntaxError('Invalid OpenAI Images multipart request'),
};

export { releaseMultipartSpool, replaySpooledMultipartRaw } from '../multipart';

export {
  EDITS_MULTIPART_AGGREGATE_LIMIT,
  EDITS_MULTIPART_ENCODED_LIMIT,
  EDITS_MULTIPART_MAX_IMAGES,
  EDITS_MULTIPART_NON_FILE_LIMIT,
  EDITS_MULTIPART_PER_FILE_LIMIT,
} from './multipart-counters';

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

export async function parseOpenAIImageEditsMultipart(
  raw: Request,
  options?: { readonly idleTimeoutMs?: number },
): Promise<OpenAIImageRequest> {
  const boundary = multipartBoundary(raw.headers.get('content-type') ?? '');
  if (boundary === undefined) throw new SyntaxError('Invalid OpenAI Images multipart request');
  const idleTimeoutMs = options?.idleTimeoutMs ?? MULTIPART_IDLE_TIMEOUT_MS;
  const releaseSlot = await acquireMultipartSlot(raw.signal);
  let spool: MultipartSpool | undefined;
  try {
    spool = await spoolMultipartBody(raw, idleTimeoutMs, 'aio-proxy-images', EDITS_MULTIPART_ENCODED_LIMIT);
    const replay = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      body: Bun.file(spool.path),
      signal: raw.signal,
    });
    const body = await decodedRequestStream(replay, MULTIPART_DECODE_LIMITS, {
      signal: raw.signal,
      idleTimeoutMs,
    });
    const { fields, uploads, namedUploads } = await parseMultipartStream(
      body,
      boundary,
      EDITS_MULTIPART_SPEC,
      raw.signal,
      idleTimeoutMs,
    );
    const maskUpload = namedUploads['mask'];
    const imageUploads = uploads.filter((upload) => upload !== maskUpload);
    if (imageUploads.length === 0) throw new SyntaxError('Invalid OpenAI Images multipart request');
    retainMultipartSpool(raw, spool);
    return {
      ...parseOpenAIImageGenerations(generationsInputFromFields(fields)),
      uploads: imageUploads,
      ...(maskUpload === undefined ? {} : { maskUpload }),
      formFields: fields,
    };
  } catch (error) {
    await spool?.unlink();
    void raw.body?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    releaseSlot();
  }
}

const MULTIPART_IDLE_TIMEOUT_MS = 600_000;

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

function parseOptionalBoolean(value: string | undefined): boolean | string | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}
