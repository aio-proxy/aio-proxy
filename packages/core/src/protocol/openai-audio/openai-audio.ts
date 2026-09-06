import { ProviderProtocol } from '@aio-proxy/types';

import { OpenAIAudioUnsupportedFeatureError } from '../../error';
import { replaySpooledMultipartRaw } from '../../ingress/multipart';
import {
  AUDIO_MULTIPART_ENCODED_LIMIT,
  type OpenAISpeechRequest,
  type OpenAITranscriptionRequest,
  parseOpenAISpeech,
  parseOpenAITranscriptionMultipart,
} from '../../ingress/openai-audio';
import { type AudioInvocation, type AudioResult, defineAudioProtocolAdapter } from '../audio-adapter';
import { openAIAudioErrors } from '../errors';
import { stripHopHeaders } from '../headers';
import { readJsonRequest, readRequestText, type RequestBodyLimits } from '../request';
import { renderTranscription, RENDERABLE_TRANSCRIPTION_FORMATS } from './transcription-egress';

export type OpenAIAudioOperation = 'speech' | 'transcriptions' | 'translations';

export type OpenAIAudioContext = {
  readonly operation: OpenAIAudioOperation;
};

/**
 * 64 KiB. Deliberately far below the multipart envelope: `/v1/audio/speech` takes
 * a JSON body whose only large field is `input`, capped by OpenAI at 4096
 * characters, so anything past a few kilobytes cannot be a valid request. Sharing
 * the 100 MiB transcription cap here would let a client stream 100 MiB before
 * being told the body is unusable.
 */
const SPEECH_JSON_BODY_LIMIT = 65_536;

const SPEECH_BODY_LIMITS = Object.freeze({
  encoded: SPEECH_JSON_BODY_LIMIT,
  decoded: SPEECH_JSON_BODY_LIMIT,
}) satisfies RequestBodyLimits;

const TRANSCRIPTION_BODY_LIMITS = Object.freeze({
  encoded: AUDIO_MULTIPART_ENCODED_LIMIT,
  decoded: AUDIO_MULTIPART_ENCODED_LIMIT,
}) satisfies RequestBodyLimits;

export const openAISpeechAdapter = defineAudioProtocolAdapter<OpenAISpeechRequest, OpenAIAudioContext>({
  capability: 'speech',
  protocol: ProviderProtocol.OpenAIAudio,
  bodyLimits: () => SPEECH_BODY_LIMITS,
  async parse(raw) {
    return parseOpenAISpeech(await readJsonRequest(raw, SPEECH_BODY_LIMITS));
  },
  model: (request) => request.model,
  async rawRequest(raw, request, resolvedModel) {
    if (!request.modelDefaulted && request.clientModel === resolvedModel) return raw.clone();
    const bodyText = await readRequestText(raw, SPEECH_BODY_LIMITS);
    return new Request(raw, {
      method: raw.method,
      body: JSON.stringify({ ...(JSON.parse(bodyText) as Record<string, unknown>), model: resolvedModel }),
      headers: stripHopHeaders(raw.headers),
    });
  },
  audioInvocation(request): AudioInvocation {
    if (request.stream_format != null) throw new OpenAIAudioUnsupportedFeatureError('stream_format');
    return {
      kind: 'speech',
      speech: {
        text: request.input,
        voice: request.voice,
        ...(request.response_format == null ? {} : { outputFormat: request.response_format }),
        ...(request.speed == null ? {} : { speed: request.speed }),
        ...(request.instructions == null ? {} : { instructions: request.instructions }),
      },
    };
  },
  audioResponse: async (result) => speechResponse(result),
  errors: openAIAudioErrors,
});

export const openAITranscriptionAdapter = defineAudioProtocolAdapter<OpenAITranscriptionRequest, OpenAIAudioContext>({
  capability: 'transcription',
  protocol: ProviderProtocol.OpenAIAudio,
  bodyLimits: () => TRANSCRIPTION_BODY_LIMITS,
  parse: (raw) => parseOpenAITranscriptionMultipart(raw),
  model: (request) => request.model,
  async rawRequest(raw, request, resolvedModel) {
    // Nothing to change: replay the spooled bytes so the client's own boundary,
    // field order, and repeated fields reach upstream untouched.
    if (!request.modelDefaulted && request.clientModel === resolvedModel) return replaySpooledMultipartRaw(raw);
    const form = new FormData();
    // The verbatim channel, not the normalized map: `formFields` strips the `[]`
    // suffix and keeps only the last repeat, so rebuilding from it would drop
    // `timestamp_granularities[]` repeats and rename the field. Every client field
    // survives; only `model` is replaced.
    for (const { name, value } of request.rawFormFields) {
      if (name === 'model') continue;
      form.append(name, value);
    }
    form.append('model', resolvedModel);
    const upload = request.upload;
    form.append(
      upload.fieldName ?? 'file',
      new File([Buffer.from(upload.data)], upload.filename ?? 'audio', {
        ...(upload.mediaType === undefined ? {} : { type: upload.mediaType }),
      }),
    );
    const headers = stripHopHeaders(raw.headers);
    // FormData must set a fresh boundary; the client's content-type names the old one.
    headers.delete('content-type');
    return new Request(raw.url, { method: raw.method, body: form, headers, signal: raw.signal });
  },
  audioInvocation(request): AudioInvocation {
    assertConvertibleTranscription(request);
    return {
      kind: 'transcription',
      transcription: {
        audio: request.upload.data,
        ...(request.upload.mediaType === undefined ? {} : { mediaType: request.upload.mediaType }),
        ...(request.language == null ? {} : { language: request.language }),
        ...(request.prompt == null ? {} : { prompt: request.prompt }),
        ...(request.temperature == null ? {} : { temperature: request.temperature }),
        ...(request.timestamp_granularities === undefined
          ? {}
          : { timestampGranularities: request.timestamp_granularities }),
      },
    };
  },
  audioResponse: async (result, request) => transcriptionResponse(result, request),
  convertSkipReason: (_request, _resolvedModelId, context) => audioConvertSkipReason(context),
  errors: openAIAudioErrors,
});

/** `transcribe` has no translation mode, so translations never take the convert path. */
export function audioConvertSkipReason(context: OpenAIAudioContext): string | undefined {
  return context.operation === 'translations' ? 'translations' : undefined;
}

// Five convert-path refusals. Four are transcription features `transcribe` cannot
// express: raw passthrough forwards them untouched, and the convert path must refuse
// them rather than answer a streaming or logprob-annotated request with a plain
// single-shot transcript. The fifth is a different kind — an output format this proxy
// cannot render. Ingress accepts any `response_format` string, and raw passthrough
// lets upstream validate it, so without this check a misspelling would quietly get a
// plain `{ text }` body on the convert path only.
function assertConvertibleTranscription(request: OpenAITranscriptionRequest): void {
  if (request.stream_format != null) throw new OpenAIAudioUnsupportedFeatureError('stream_format');
  if (request.chunking_strategy != null) throw new OpenAIAudioUnsupportedFeatureError('chunking_strategy');
  if (request.stream === true) throw new OpenAIAudioUnsupportedFeatureError('stream');
  // `include` is not modelled by the schema, so the verbatim channel is the only
  // place it appears; a client may spell it with or without the PHP-style `[]`.
  if (request.rawFormFields.some((field) => field.name === 'include' || field.name === 'include[]')) {
    throw new OpenAIAudioUnsupportedFeatureError('include');
  }
  // 501 rather than 400: the convert path cannot tell a client misspelling from a
  // format OpenAI added after this code was written, and either way the honest
  // statement is that this path cannot render it. Absent and `null` mean `json`.
  if (request.response_format != null && !RENDERABLE_TRANSCRIPTION_FORMATS.has(request.response_format)) {
    throw new OpenAIAudioUnsupportedFeatureError('response_format');
  }
}

function speechResponse(result: AudioResult): Response {
  if (result.kind !== 'speech') throw new TypeError('OpenAI Audio speech egress requires a speech result');
  return new Response(Buffer.from(result.speech.audio), {
    headers: { 'content-type': result.speech.mediaType },
  });
}

function transcriptionResponse(result: AudioResult, request: OpenAITranscriptionRequest): Response {
  if (result.kind !== 'transcription') {
    throw new TypeError('OpenAI Audio transcription egress requires a transcription result');
  }
  return renderTranscription(result.transcription, request.response_format);
}
