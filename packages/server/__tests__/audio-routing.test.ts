import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createServer, createServerTestHome } from '#server-test-lifecycle';

import type { InboundCapability, ModelCapabilityIndex, RawResolveInput, RuntimeProviderInstance } from '../src/runtime';
import { recorded } from './trace-recording.test-support';

const SPEECH_MODEL = 'tts-1';
const TRANSCRIPTION_MODEL = 'whisper-1';

const SPEECH = '/v1/audio/speech';
const TRANSCRIPTIONS = '/v1/audio/transcriptions';
const TRANSLATIONS = '/v1/audio/translations';

function speechBody(body: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: SPEECH_MODEL, input: 'hello', voice: 'alloy', ...body });
}

// No hand-set content-type: `new Request` derives the multipart boundary from the
// FormData, and naming a stale boundary makes every transcription request a 400.
function transcriptionForm(options: { readonly file?: false } = {}): FormData {
  const form = new FormData();
  if (options.file !== false) {
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'clip.mp3', { type: 'audio/mpeg' }));
  }
  form.append('model', TRANSCRIPTION_MODEL);
  return form;
}

describe('OpenAI audio HTTP dispatch matrix', () => {
  test('POST /v1/audio/speech raw-passthroughs and names the speech direction and path', async () => {
    const fixture = audioProvider('azure', { raw: {}, speech: true, language: true });
    const response = await request(SPEECH, [fixture.value], { body: speechBody() });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fixture.calls).toEqual({ model: 0, raw: 1, speech: 0, transcription: 0 });
    expect(fixture.resolves).toEqual([
      {
        protocol: ProviderProtocol.OpenAIAudio,
        modelId: SPEECH_MODEL,
        capability: 'speech',
        requestPath: SPEECH,
      },
    ]);
  });

  test('POST /v1/audio/speech converts through the speech transport, never the language one', async () => {
    const fixture = audioProvider('sdk', { speech: true, language: true });
    const response = await request(SPEECH, [fixture.value], { body: speechBody({ response_format: 'opus' }) });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/opus');
    expect(fixture.calls).toEqual({ model: 0, raw: 0, speech: 1, transcription: 0 });
    expect(fixture.speechInvocations).toEqual([{ text: 'hello', voice: 'alloy', outputFormat: 'opus' }]);
  });

  test('POST /v1/audio/transcriptions reads the multipart upload and converts to json', async () => {
    const fixture = audioProvider('sdk', { speech: true, transcription: true, language: true });
    const response = await request(TRANSCRIPTIONS, [fixture.value], { form: transcriptionForm() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'transcribed' });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, speech: 0, transcription: 1 });
    expect(fixture.transcriptionAudio).toEqual([new Uint8Array([1, 2, 3])]);
  });

  test('POST /v1/audio/translations raw-passthroughs but is refused on the convert path', async () => {
    const raw = audioProvider('azure', { raw: {} });
    const rawResponse = await request(TRANSLATIONS, [raw.value], { form: transcriptionForm() });

    expect(rawResponse.status).toBe(200);
    expect(await rawResponse.json()).toEqual({ text: 'raw:azure' });
    expect(raw.calls).toEqual({ model: 0, raw: 1, speech: 0, transcription: 0 });
    expect(raw.resolves).toEqual([
      {
        protocol: ProviderProtocol.OpenAIAudio,
        modelId: TRANSCRIPTION_MODEL,
        capability: 'transcription',
        requestPath: TRANSLATIONS,
      },
    ]);

    const convert = audioProvider('sdk', { transcription: true });
    const convertResponse = await request(TRANSLATIONS, [convert.value], { form: transcriptionForm() });

    expect(convertResponse.status).toBe(501);
    expect(await convertResponse.json()).toMatchObject({
      error: { code: 'unsupported_feature', type: 'invalid_request_error' },
    });
    expect(convert.calls).toEqual({ model: 0, raw: 0, speech: 0, transcription: 0 });
  });

  test('a failing audio candidate falls back to the next provider', async () => {
    const broken = audioProvider('broken', { raw: { status: 500 }, priority: 10 });
    const healthy = audioProvider('azure', { raw: {} });
    const home = createServerTestHome();
    const response = await request(SPEECH, [broken.value, healthy.value], { body: speechBody(), dbHome: home });

    expect(response.status).toBe(200);
    // The trace finalizes when the response body settles, so read it before the traces.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(broken.calls).toEqual({ model: 0, raw: 1, speech: 0, transcription: 0 });
    expect(healthy.calls).toEqual({ model: 0, raw: 1, speech: 0, transcription: 0 });
    expect(await recordedAttempts(home)).toEqual([
      expect.objectContaining({ outcome: 'failure', providerId: 'broken', statusCode: 500 }),
      expect.objectContaining({ outcome: 'success', providerId: 'azure' }),
    ]);
  });

  test('a routable model with no audio grant answers 501 not_implemented', async () => {
    const fixture = audioProvider('sdk', { capabilities: ['language'], language: true });
    const response = await request(SPEECH, [fixture.value], { body: speechBody() });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: 'not_implemented', type: 'invalid_request_error' },
    });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, speech: 0, transcription: 0 });
  });

  test('a transcription request with no file part is 400 invalid_request', async () => {
    const fixture = audioProvider('sdk', { transcription: true });
    const response = await request(TRANSCRIPTIONS, [fixture.value], { form: transcriptionForm({ file: false }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', type: 'invalid_request_error' },
    });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, speech: 0, transcription: 0 });
  });

  test('a speech request that omits the model routes on the defaulted id', async () => {
    const fixture = audioProvider('sdk', { models: [SPEECH_MODEL], speech: true });
    const response = await request(SPEECH, [fixture.value], {
      body: JSON.stringify({ input: 'hello', voice: 'alloy' }),
    });

    expect(response.status).toBe(200);
    expect(fixture.calls).toEqual({ model: 0, raw: 0, speech: 1, transcription: 0 });
  });
});

type AudioCalls = { model: number; raw: number; speech: number; transcription: number };

type AudioProviderOptions = {
  /** Index grants, applied to every listed model. Defaults to both audio directions. */
  readonly capabilities?: readonly InboundCapability[];
  readonly models?: readonly string[];
  readonly priority?: number;
  readonly raw?: { readonly status?: number };
  readonly speech?: boolean;
  readonly transcription?: boolean;
  readonly language?: boolean;
};

type AudioFixture = {
  readonly calls: AudioCalls;
  readonly resolves: RawResolveInput[];
  readonly speechInvocations: unknown[];
  readonly transcriptionAudio: Uint8Array[];
  readonly value: RuntimeProviderInstance;
};

/**
 * A materialized audio provider. The index grant is explicit because
 * `buildModelCapabilityIndex` only synthesizes speech/transcription from a listed
 * protocol, and `RuntimeProviderInstance` carries no protocol — so a
 * raw-passthrough fixture without one is filtered out before dispatch.
 */
function audioProvider(id: string, options: AudioProviderOptions = {}): AudioFixture {
  const calls: AudioCalls = { model: 0, raw: 0, speech: 0, transcription: 0 };
  const resolves: RawResolveInput[] = [];
  const speechInvocations: unknown[] = [];
  const transcriptionAudio: Uint8Array[] = [];
  const models = options.models ?? [SPEECH_MODEL, TRANSCRIPTION_MODEL];
  const granted = new Set(options.capabilities ?? (['speech', 'transcription'] as const));
  const capabilityIndex: Record<string, ReadonlySet<InboundCapability>> = {};
  for (const model of models) capabilityIndex[model] = granted;

  return {
    calls,
    resolves,
    speechInvocations,
    transcriptionAudio,
    value: {
      capabilityIndex: capabilityIndex satisfies ModelCapabilityIndex,
      enabled: true,
      id,
      kind: ProviderKind.Api,
      models,
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.raw === undefined
        ? {}
        : {
            raw: {
              resolve: (input: RawResolveInput) => {
                resolves.push(input);
                if (input.protocol !== ProviderProtocol.OpenAIAudio) return undefined;
                return {
                  invoke: async () => rawAudioResponse(id, input.capability, options.raw?.status ?? 200, calls),
                };
              },
            },
          }),
      ...(options.speech === true
        ? {
            speech: {
              invoke: async (invocation: unknown) => {
                calls.speech += 1;
                speechInvocations.push(invocation);
                const outputFormat = (invocation as { readonly outputFormat?: string }).outputFormat;
                return {
                  audio: new Uint8Array([7, 8, 9]),
                  mediaType: outputFormat === undefined ? 'audio/mpeg' : `audio/${outputFormat}`,
                };
              },
            },
          }
        : {}),
      ...(options.transcription === true
        ? {
            transcription: {
              invoke: async (invocation: { readonly audio: Uint8Array }) => {
                calls.transcription += 1;
                transcriptionAudio.push(invocation.audio);
                return { text: 'transcribed', segments: [] };
              },
            },
          }
        : {}),
      ...(options.language === true ? { model: { invoke: () => ((calls.model += 1), new ReadableStream()) } } : {}),
    } as unknown as RuntimeProviderInstance,
  };
}

// The raw body differs per direction, so a test that reads it proves the pipeline
// threaded `capability` rather than guessing one direction for both ports.
function rawAudioResponse(id: string, capability: string | undefined, status: number, calls: AudioCalls): Response {
  calls.raw += 1;
  if (status !== 200) return new Response('upstream unavailable', { status });
  return capability === 'speech'
    ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })
    : Response.json({ text: `raw:${id}` });
}

async function request(
  path: string,
  providers: readonly RuntimeProviderInstance[],
  inbound: { readonly body?: string; readonly form?: FormData; readonly dbHome?: string },
) {
  const app = await createServer({
    config: { providers: {} },
    ...(inbound.dbHome === undefined ? {} : { dbHome: inbound.dbHome }),
    providerInstances: providers,
  });
  return app.request(
    path,
    inbound.form === undefined
      ? { body: inbound.body, headers: { 'content-type': 'application/json' }, method: 'POST' }
      : { body: inbound.form, method: 'POST' },
  );
}

async function recordedAttempts(home: string) {
  const { requests } = await recorded(home);
  return requests[0]?.attempts ?? [];
}
