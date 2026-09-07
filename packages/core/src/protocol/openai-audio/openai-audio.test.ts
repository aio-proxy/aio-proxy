import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { releaseMultipartSpool } from '../../ingress/multipart';
import { openAISpeechAdapter, openAITranscriptionAdapter } from './openai-audio';

function speechRequest(body: Record<string, unknown>): Request {
  return new Request('https://proxy.test/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function transcriptionRequest(model?: string, extra: readonly (readonly [string, string])[] = []): Request {
  const boundary = 'AUDIOB';
  const parts = [
    'Content-Disposition: form-data; name="file"; filename="clip.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nID3AUDIO',
    ...(model === undefined ? [] : [`Content-Disposition: form-data; name="model"\r\n\r\n${model}`]),
    ...extra.map(([name, value]) => `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`),
  ];
  const text = `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
  return new Request('https://proxy.test/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new TextEncoder().encode(text),
  });
}

describe('openAISpeechAdapter', () => {
  test('declares the audio protocol and the speech capability', () => {
    expect(openAISpeechAdapter.protocol).toBe(ProviderProtocol.OpenAIAudio);
    expect(openAISpeechAdapter.capability).toBe('speech');
    expect(openAITranscriptionAdapter.capability).toBe('transcription');
  });

  test('parses a speech body and resolves the model', async () => {
    const request = await openAISpeechAdapter.parse(speechRequest({ input: 'hi', voice: 'alloy' }), {
      operation: 'speech',
    });
    expect(openAISpeechAdapter.model(request, { operation: 'speech' })).toBe('tts-1');
  });

  test('rewrites the raw body only when the resolved model differs', async () => {
    const context = { operation: 'speech' } as const;
    const unchanged = speechRequest({ model: 'tts-1', input: 'hi', voice: 'alloy' });
    const parsedUnchanged = await openAISpeechAdapter.parse(unchanged.clone(), context);
    const same = await openAISpeechAdapter.rawRequest(unchanged, parsedUnchanged, 'tts-1', new Set(), context);
    expect(await same.json()).toEqual({ model: 'tts-1', input: 'hi', voice: 'alloy' });

    const changed = speechRequest({ model: 'tts-1', input: 'hi', voice: 'alloy' });
    const parsedChanged = await openAISpeechAdapter.parse(changed.clone(), context);
    const rewritten = await openAISpeechAdapter.rawRequest(changed, parsedChanged, 'tts-1-hd', new Set(), context);
    expect(await rewritten.json()).toEqual({ model: 'tts-1-hd', input: 'hi', voice: 'alloy' });
  });

  test('converts a speech request into a speech invocation', async () => {
    const context = { operation: 'speech' } as const;
    const request = await openAISpeechAdapter.parse(
      speechRequest({ input: 'hi', voice: 'nova', response_format: 'opus', speed: 1.5, instructions: 'slow' }),
      context,
    );
    const invocation = openAISpeechAdapter.audioInvocation(request, context);
    expect(invocation).toEqual({
      kind: 'speech',
      speech: { text: 'hi', voice: 'nova', outputFormat: 'opus', speed: 1.5, instructions: 'slow' },
    });
  });

  test('rejects stream_format on the convert path', async () => {
    const context = { operation: 'speech' } as const;
    const request = await openAISpeechAdapter.parse(
      speechRequest({ input: 'hi', voice: 'alloy', stream_format: 'sse' }),
      context,
    );
    expect(() => openAISpeechAdapter.audioInvocation(request, context)).toThrow(
      'OpenAI Audio feature is not supported: stream_format',
    );
  });

  test('answers with the generated audio bytes and media type', async () => {
    const context = { operation: 'speech' } as const;
    const request = await openAISpeechAdapter.parse(speechRequest({ input: 'hi', voice: 'alloy' }), context);
    const response = await openAISpeechAdapter.audioResponse(
      { kind: 'speech', speech: { audio: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' } },
      request,
      { modelId: 'tts-1' },
    );
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('openAITranscriptionAdapter', () => {
  test('parses multipart without touching readJsonRequest', async () => {
    const raw = transcriptionRequest('whisper-large');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    expect(openAITranscriptionAdapter.model(request, { operation: 'transcriptions' })).toBe('whisper-large');
    expect(request.upload.filename).toBe('clip.mp3');
    await releaseMultipartSpool(raw);
  });

  test('replays the spooled body verbatim when the model is unchanged', async () => {
    const raw = transcriptionRequest('whisper-1', [['timestamp_granularities[]', 'word']]);
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const upstream = await openAITranscriptionAdapter.rawRequest(raw, request, 'whisper-1', new Set(), {
      operation: 'transcriptions',
    });
    expect(upstream.headers.get('content-type')).toContain('multipart/form-data; boundary=AUDIOB');
    expect(await upstream.text()).toContain('timestamp_granularities[]');
    await releaseMultipartSpool(raw);
  });

  test('rebuilds multipart keeping every client field when the model changes', async () => {
    const raw = transcriptionRequest('whisper-1', [['timestamp_granularities[]', 'word']]);
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const upstream = await openAITranscriptionAdapter.rawRequest(raw, request, 'whisper-large', new Set(), {
      operation: 'transcriptions',
    });
    const form = await upstream.formData();
    expect(form.get('model')).toBe('whisper-large');
    expect(form.get('timestamp_granularities[]')).toBe('word');
    expect(form.get('file')).toBeInstanceOf(File);
    await releaseMultipartSpool(raw);
  });

  test('skips the convert path for translations', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'translations' });
    expect(openAITranscriptionAdapter.convertSkipReason?.(request, 'whisper-1', { operation: 'translations' })).toBe(
      'translations',
    );
    await releaseMultipartSpool(raw);
  });

  test('has no convert skip reason for transcriptions', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    expect(
      openAITranscriptionAdapter.convertSkipReason?.(request, 'whisper-1', { operation: 'transcriptions' }),
    ).toBeUndefined();
    await releaseMultipartSpool(raw);
  });

  // Each of these four features changes the SHAPE of a transcription response, and
  // `transcribe` cannot express any of them. Silently answering with a plain
  // single-shot transcript would look like success to the client.
  test.each([
    [[['stream_format', 'sse']], 'stream_format'],
    [[['chunking_strategy', 'auto']], 'chunking_strategy'],
    [[['stream', 'true']], 'stream'],
    [[['include[]', 'logprobs']], 'include'],
  ] as const)('refuses %o on the convert path', async (extra, feature) => {
    const raw = transcriptionRequest('whisper-1', extra);
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    expect(() => openAITranscriptionAdapter.audioInvocation(request, { operation: 'transcriptions' })).toThrow(
      `OpenAI Audio feature is not supported: ${feature}`,
    );
    await releaseMultipartSpool(raw);
  });

  // Ingress accepts any `response_format` string and raw passthrough lets upstream
  // validate it, so without a convert-path refusal a misspelling would quietly get a
  // plain `{ text }` body from this path alone.
  test('refuses a response_format it cannot render on the convert path', async () => {
    const raw = transcriptionRequest('whisper-1', [['response_format', 'bogus']]);
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    expect(() => openAITranscriptionAdapter.audioInvocation(request, { operation: 'transcriptions' })).toThrow(
      'OpenAI Audio feature is not supported: response_format',
    );
    await releaseMultipartSpool(raw);
  });

  test.each([[[['response_format', 'json']] as const], [[] as const]])(
    'renders the json default for %o on the convert path',
    async (extra) => {
      const raw = transcriptionRequest('whisper-1', extra);
      const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
      expect(() => openAITranscriptionAdapter.audioInvocation(request, { operation: 'transcriptions' })).not.toThrow();
      const response = await openAITranscriptionAdapter.audioResponse(
        { kind: 'transcription', transcription: { text: 'hello', segments: [] } },
        request,
        { modelId: 'whisper-1' },
      );
      expect(await response.json()).toEqual({ text: 'hello' });
      await releaseMultipartSpool(raw);
    },
  );

  // `transcribe()` returns segment timings only, so a forwarded `word` granularity
  // would be honoured upstream and then dropped on the way back. Raw passthrough
  // still serves it; only the convert path refuses.
  test('refuses word timestamp granularity on the convert path', async () => {
    const raw = transcriptionRequest('whisper-1', [['timestamp_granularities[]', 'word']]);
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    expect(() => openAITranscriptionAdapter.audioInvocation(request, { operation: 'transcriptions' })).toThrow(
      'OpenAI Audio feature is not supported: timestamp_granularities',
    );
    await releaseMultipartSpool(raw);
  });

  // These reach upstream only through the invocation: dropping them ran the
  // transcription on provider defaults, so `language=ja` was silently ignored.
  test('carries the transcription controls into the invocation', async () => {
    const raw = transcriptionRequest('whisper-1', [
      ['language', 'ja'],
      ['prompt', 'proper nouns'],
      ['temperature', '0.2'],
      ['timestamp_granularities[]', 'segment'],
    ]);
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const invocation = openAITranscriptionAdapter.audioInvocation(request, { operation: 'transcriptions' });
    expect(invocation.kind).toBe('transcription');
    expect(invocation).toMatchObject({
      transcription: {
        language: 'ja',
        prompt: 'proper nouns',
        temperature: 0.2,
        timestampGranularities: ['segment'],
      },
    });
    await releaseMultipartSpool(raw);
  });

  test('omits an unset transcription control instead of passing undefined', async () => {
    const raw = transcriptionRequest('whisper-1', [['language', 'ja']]);
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const invocation = openAITranscriptionAdapter.audioInvocation(request, { operation: 'transcriptions' });
    if (invocation.kind !== 'transcription') throw new TypeError('expected a transcription invocation');
    expect(invocation.transcription).not.toHaveProperty('prompt');
    expect(invocation.transcription).not.toHaveProperty('temperature');
    await releaseMultipartSpool(raw);
  });

  test('renders the requested response format on egress', async () => {
    const raw = transcriptionRequest('whisper-1');
    const request = await openAITranscriptionAdapter.parse(raw, { operation: 'transcriptions' });
    const response = await openAITranscriptionAdapter.audioResponse(
      { kind: 'transcription', transcription: { text: 'hello', segments: [] } },
      request,
      { modelId: 'whisper-1' },
    );
    expect(await response.json()).toEqual({ text: 'hello' });
    await releaseMultipartSpool(raw);
  });
});
