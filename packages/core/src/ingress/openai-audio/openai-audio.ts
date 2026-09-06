import { z } from 'zod';

import { multipartFieldNumber } from '../multipart';

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

export function parseOpenAITranscriptionFields(fields: Readonly<Record<string, string>>): OpenAITranscriptionFields {
  const input: Record<string, unknown> = {
    ...(fields['model'] === undefined ? {} : { model: fields['model'] }),
    // A repeated `timestamp_granularities[]` collapses to its last value in the
    // reader's normalized field map. That is enough for the model path; the raw path
    // rebuilds from `rawFormFields`, which keeps every repeat.
    ...(fields['timestamp_granularities'] === undefined
      ? {}
      : { timestamp_granularities: [fields['timestamp_granularities']] }),
  };
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (fields[key] !== undefined) input[key] = fields[key];
  }
  const temperature = multipartFieldNumber(fields['temperature']);
  if (temperature !== undefined) input['temperature'] = temperature;
  const stream = parseOptionalBoolean(fields['stream']);
  if (stream !== undefined) input['stream'] = stream;
  const parsed = OpenAITranscriptionFieldsSchema.parse(input);
  const { model, ...rest } = parsed;
  return { ...rest, ...resolveModel(model, CPA_DEFAULT_TRANSCRIPTION_MODEL) };
}

// A blank or absent model is the documented default, not an error: OpenAI's own
// clients omit it. `clientModel` records what the client actually sent so the raw
// path can skip rewriting when nothing changed.
function resolveModel(model: string | null | undefined, fallback: string): ResolvedAudioModel {
  const trimmed = model?.trim();
  if (trimmed === undefined || trimmed.length === 0) return { model: fallback, modelDefaulted: true };
  return { model: trimmed, modelDefaulted: false, clientModel: trimmed };
}

// Same "empty means absent" rule as `multipartFieldNumber`. A value that is neither
// boolean literal is passed through unchanged so the schema reports it instead of
// coercing it to false.
function parseOptionalBoolean(value: string | undefined): boolean | string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return value;
}
