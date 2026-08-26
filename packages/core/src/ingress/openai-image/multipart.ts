import { decodedRequestStream, type RequestBodyLimits } from '../../protocol/request';
import { EDITS_MULTIPART_ENCODED_LIMIT } from './multipart-counters';
import { parseMultipartStream } from './multipart-stream';
import { parseOpenAIImageGenerations, type OpenAIImageRequest } from './openai-image';

const MULTIPART_DECODE_LIMITS = Object.freeze({
  encoded: EDITS_MULTIPART_ENCODED_LIMIT,
  decoded: EDITS_MULTIPART_ENCODED_LIMIT,
}) satisfies RequestBodyLimits;

export {
  EDITS_MULTIPART_AGGREGATE_LIMIT,
  EDITS_MULTIPART_ENCODED_LIMIT,
  EDITS_MULTIPART_MAX_IMAGES,
  EDITS_MULTIPART_MAX_MASKS,
  EDITS_MULTIPART_NON_FILE_LIMIT,
  EDITS_MULTIPART_PER_FILE_LIMIT,
  assertEditsMultipartCounters,
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

export async function parseOpenAIImageEditsMultipart(raw: Request): Promise<OpenAIImageRequest> {
  const boundary = multipartBoundary(raw.headers.get('content-type') ?? '');
  if (boundary === undefined) throw new SyntaxError('Invalid OpenAI Images multipart request');
  await acquireMultipartSlot();
  try {
    const body = await decodedRequestStream(raw, MULTIPART_DECODE_LIMITS);
    const { fields, uploads, maskUpload } = await parseMultipartStream(body, boundary);
    if (uploads.length === 0) throw new SyntaxError('Invalid OpenAI Images multipart request');
    return {
      ...parseOpenAIImageGenerations(generationsInputFromFields(fields)),
      uploads,
      ...(maskUpload === undefined ? {} : { maskUpload }),
      formFields: fields,
    };
  } catch (error) {
    void raw.body?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    releaseMultipartSlot();
  }
}

// Process-protection cap on concurrent official-max edits parses. This is not a
// compatibility ceiling and does not shrink the per-request encoded limit.
const MAX_IN_FLIGHT_MULTIPART_PARSES = 2;
let inFlightMultipartParses = 0;
const multipartWaiters: Array<() => void> = [];

async function acquireMultipartSlot(): Promise<void> {
  if (inFlightMultipartParses >= MAX_IN_FLIGHT_MULTIPART_PARSES) {
    await new Promise<void>((resolve) => {
      multipartWaiters.push(resolve);
    });
  }
  inFlightMultipartParses += 1;
}

function releaseMultipartSlot(): void {
  inFlightMultipartParses -= 1;
  multipartWaiters.shift()?.();
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

function multipartBoundary(contentType: string): string | undefined {
  const match = /(?:^|;\s*)boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2]?.trim();
  return boundary === undefined || boundary === '' ? undefined : boundary;
}
