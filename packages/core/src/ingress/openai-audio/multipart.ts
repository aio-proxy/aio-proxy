import { decodedRequestStream, type RequestBodyLimits } from '../../protocol/request';
import {
  acquireMultipartSlot,
  multipartBoundary,
  type MultipartRawField,
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
/**
 * The widest a single upload may be: the whole envelope minus the non-file budget,
 * which is the most file bytes that can fit once framing and text fields are paid
 * for. `MultipartLimits.perFile` is an INCLUSIVE maximum, so a file of exactly this
 * size is accepted and one byte more is refused — chosen so the audio ports own
 * their per-file rejection instead of inheriting it from whichever shared layer
 * happens to be stricter today.
 */
export const AUDIO_MULTIPART_PER_FILE_LIMIT = AUDIO_MULTIPART_ENCODED_LIMIT - AUDIO_MULTIPART_NON_FILE_LIMIT;

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
    perFile: AUDIO_MULTIPART_PER_FILE_LIMIT,
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
  /**
   * Non-file fields normalized and deduped, matching the shape the schema parsed.
   * Suitable for reading a single known field; NOT for raw replay.
   */
  readonly formFields: Readonly<Record<string, string>>;
  /**
   * Every non-file field verbatim — raw field name (`timestamp_granularities[]`
   * keeps its brackets), every repeat, in wire order. Raw-path passthrough must
   * rebuild the upstream form from this so no client field is dropped or renamed.
   */
  readonly rawFormFields: readonly MultipartRawField[];
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
    const { fields, rawFields, namedUploads } = await parseMultipartStream(
      body,
      boundary,
      AUDIO_MULTIPART_SPEC,
      raw.signal,
      idleTimeoutMs,
    );
    const upload = namedUploads['file'];
    // A zero-byte `file` is a client mistake worth naming here: forwarding it only
    // buys an opaque upstream error for a request that can never transcribe.
    if (upload === undefined || upload.byteLength === 0) {
      throw new SyntaxError('Invalid OpenAI Audio multipart request');
    }
    // Retain only after the schema has accepted the request: a rejected parse
    // unlinks the spool in `catch`, and a WeakMap entry left pointing at the
    // deleted file would hand raw replay a body that no longer exists.
    const parsed = parseOpenAITranscriptionFields(fields);
    retainMultipartSpool(raw, spool);
    return { ...parsed, upload, formFields: fields, rawFormFields: rawFields };
  } catch (error) {
    await spool?.unlink();
    void raw.body?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    releaseSlot();
  }
}
