import { z } from 'zod';

import { multipartFieldBoolean, multipartFieldNumber, type MultipartRawField } from '../multipart';

/** OpenAI's own default for `POST /v1/audio/speech` when the client omits `model`. */
export const CPA_DEFAULT_SPEECH_MODEL = 'tts-1';
/** OpenAI's own default for the transcriptions and translations ports. */
export const CPA_DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

const OpenAISpeechInputSchema = z.compile(
  z.object({
    model: z.union([z.string(), z.null()]).optional(),
    input: z.string(),
    voice: z.string(),
    response_format: nullableString,
    speed: nullableNumber,
    instructions: nullableString,
    stream_format: nullableString,
  }),
);

const OpenAITranscriptionFieldsSchema = z.compile(
  z.object({
    model: z.union([z.string(), z.null()]).optional(),
    response_format: nullableString,
    language: nullableString,
    prompt: nullableString,
    temperature: nullableNumber,
    // Carried only. Transcription streaming is signalled by `stream_format == 'sse'`,
    // never by this flag; it is here so the convert path can refuse it explicitly
    // instead of silently answering a streaming request with a single JSON body.
    stream: z.boolean().nullable().optional(),
    stream_format: nullableString,
    chunking_strategy: nullableString,
    timestamp_granularities: z.array(z.string()).optional(),
  }),
);

export type OpenAISpeechRequest = {
  readonly model: string;
  readonly modelDefaulted: boolean;
  readonly clientModel?: string;
  readonly input: string;
  readonly voice: string;
  readonly response_format?: string | null;
  readonly speed?: number | null;
  readonly instructions?: string | null;
  readonly stream_format?: string | null;
};

export function parseOpenAISpeech(body: unknown): OpenAISpeechRequest {
  const parsed = OpenAISpeechInputSchema.parse(body);
  const { model, ...rest } = parsed;
  return { ...rest, ...resolveModel(model, CPA_DEFAULT_SPEECH_MODEL) };
}

export type TranscriptionFields = z.output<typeof OpenAITranscriptionFieldsSchema>;

export type ResolvedAudioModel = {
  readonly model: string;
  readonly modelDefaulted: boolean;
  readonly clientModel?: string;
};

export type OpenAITranscriptionFields = ResolvedAudioModel & Omit<TranscriptionFields, 'model'>;

const OPTIONAL_STRING_FIELDS = [
  'response_format',
  'language',
  'prompt',
  'stream_format',
  'chunking_strategy',
] as const satisfies readonly (keyof TranscriptionFields)[];

export function parseOpenAITranscriptionFields(
  fields: Readonly<Record<string, string>>,
  rawFields: readonly MultipartRawField[] = [],
): OpenAITranscriptionFields {
  const granularities = timestampGranularities(fields, rawFields);
  const input: Record<string, unknown> = {
    ...(fields['model'] === undefined ? {} : { model: fields['model'] }),
    ...(granularities === undefined ? {} : { timestamp_granularities: granularities }),
  };
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (fields[key] !== undefined) input[key] = fields[key];
  }
  const temperature = multipartFieldNumber(fields['temperature']);
  if (temperature !== undefined) input['temperature'] = temperature;
  const stream = multipartFieldBoolean(fields['stream']);
  if (stream !== undefined) input['stream'] = stream;
  const parsed = OpenAITranscriptionFieldsSchema.parse(input);
  const { model, ...rest } = parsed;
  return { ...rest, ...resolveModel(model, CPA_DEFAULT_TRANSCRIPTION_MODEL) };
}

// `timestamp_granularities` is the one repeatable field on this port, and the reader's
// normalized map keeps only the last repeat, so `word,segment` would arrive as
// `segment` alone. The verbatim channel carries every repeat in wire order; a client
// may spell the name with or without the PHP-style `[]`, and both mean the same field.
// Falls back to the normalized map so a caller with no raw channel still works.
function timestampGranularities(
  fields: Readonly<Record<string, string>>,
  rawFields: readonly MultipartRawField[],
): readonly string[] | undefined {
  const repeats = rawFields
    .filter((field) => field.name === 'timestamp_granularities' || field.name === 'timestamp_granularities[]')
    .map((field) => field.value);
  if (repeats.length > 0) return repeats;
  const normalized = fields['timestamp_granularities'];
  return normalized === undefined ? undefined : [normalized];
}

// A blank or absent model is the documented default, not an error: OpenAI's own
// clients omit it. `clientModel` records what the client actually WROTE, untrimmed,
// so the raw path's equality check skips the rewrite only when nothing changed —
// `" whisper-1 "` routes on the trimmed id but must still be rewritten, or the
// padded value reaches upstream and comes back as model-not-found.
function resolveModel(model: string | null | undefined, fallback: string): ResolvedAudioModel {
  if (typeof model !== 'string') return { model: fallback, modelDefaulted: true };
  const trimmed = model.trim();
  if (trimmed.length === 0) return { model: fallback, modelDefaulted: true };
  return { model: trimmed, modelDefaulted: false, clientModel: model };
}
