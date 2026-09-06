import { decodedRequestStream, type RequestBodyLimits } from '../../protocol/request';
import {
  acquireMultipartSlot,
  multipartBoundary,
  type MultipartSpool,
  type MultipartStreamSpec,
  type MultipartUpload,
  parseMultipartStream,
  retainMultipartSpool,
  spoolMultipartBody,
} from '../multipart';
import { type OpenAITranscriptionFields, parseOpenAITranscriptionFields } from './openai-audio';

/**
 * 100 MiB, the widest envelope aio-proxy accepts on the audio ports. Applied to
 * transcriptions AND translations alike, so a large translation 413s explicitly
 * instead of failing somewhere downstream.
 */
export const AUDIO_MULTIPART_ENCODED_LIMIT = 104_857_600;
const AUDIO_MULTIPART_NON_FILE_LIMIT = 1_048_576;
const AUDIO_MULTIPART_IDLE_TIMEOUT_MS = 600_000;

const MULTIPART_DECODE_LIMITS = Object.freeze({
  encoded: AUDIO_MULTIPART_ENCODED_LIMIT,
  decoded: AUDIO_MULTIPART_ENCODED_LIMIT,
}) satisfies RequestBodyLimits;

const AUDIO_MULTIPART_SPEC: MultipartStreamSpec = {
  // `file` must be in both sets: `startPart` consults `fileFields` first, so a name
  // listed only as a singleton would be decoded as text instead of read as an upload.
  fileFields: new Set(['file']),
  singletonFileFields: new Set(['file']),
  limits: {
    // No exclusive-cap adjustment here, unlike Images: 100 MiB is our own envelope
    // ceiling rather than a published per-file maximum, and the encoded envelope
    // (file bytes plus framing) always trips before a file can reach it.
    perFile: AUDIO_MULTIPART_ENCODED_LIMIT,
    aggregate: AUDIO_MULTIPART_ENCODED_LIMIT,
    nonFile: AUDIO_MULTIPART_NON_FILE_LIMIT,
    // Total across repeatable file fields. `file` is a singleton, so this budget is
    // unused and any second `file` part is refused by the singleton rule.
    maxFiles: 1,
  },
  syntaxError: () => new SyntaxError('Invalid OpenAI Audio multipart request'),
};

export type OpenAITranscriptionRequest = OpenAITranscriptionFields & {
  readonly upload: MultipartUpload;
  /** Every field the client sent, verbatim, so the raw path can replay them. */
  readonly formFields: Readonly<Record<string, string>>;
};

export async function parseOpenAITranscriptionMultipart(
  raw: Request,
  options?: { readonly idleTimeoutMs?: number },
): Promise<OpenAITranscriptionRequest> {
  const boundary = multipartBoundary(raw.headers.get('content-type') ?? '');
  if (boundary === undefined) throw new SyntaxError('Invalid OpenAI Audio multipart request');
  const idleTimeoutMs = options?.idleTimeoutMs ?? AUDIO_MULTIPART_IDLE_TIMEOUT_MS;
  const releaseSlot = await acquireMultipartSlot(raw.signal);
  let spool: MultipartSpool | undefined;
  try {
    // The audio cap must be passed explicitly: the spool defaults to the
    // process-wide ceiling, so omitting it would land an 851 MB body on disk
    // before this protocol's own limit could reject it.
    spool = await spoolMultipartBody(raw, idleTimeoutMs, 'aio-proxy-audio', AUDIO_MULTIPART_ENCODED_LIMIT);
    const replay = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      body: Bun.file(spool.path),
      signal: raw.signal,
    });
    const body = await decodedRequestStream(replay, MULTIPART_DECODE_LIMITS, { signal: raw.signal, idleTimeoutMs });
    const { fields, namedUploads } = await parseMultipartStream(
      body,
      boundary,
      AUDIO_MULTIPART_SPEC,
      raw.signal,
      idleTimeoutMs,
    );
    const upload = namedUploads['file'];
    if (upload === undefined) throw new SyntaxError('Invalid OpenAI Audio multipart request');
    retainMultipartSpool(raw, spool);
    return { ...parseOpenAITranscriptionFields(fields), upload, formFields: fields };
  } catch (error) {
    await spool?.unlink();
    void raw.body?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    releaseSlot();
  }
}
