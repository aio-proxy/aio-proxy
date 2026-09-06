import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { extractPassthroughObservation } from '../passthrough-usage';
import { openAIAudioUsage } from './openai-audio';

describe('openAIAudioUsage', () => {
  test('reads the usage block a transcription response reports', () => {
    expect(
      openAIAudioUsage({
        text: 'hi',
        usage: { type: 'tokens', input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      }),
    ).toEqual({
      kind: 'valid',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
  });

  test('reads audio input token details when the provider reports them', () => {
    expect(
      openAIAudioUsage({
        usage: {
          type: 'tokens',
          input_tokens: 20,
          input_token_details: { text_tokens: 5, audio_tokens: 15 },
          output_tokens: 4,
        },
      }),
    ).toEqual({
      kind: 'valid',
      usage: { inputTokens: 20, inputAudioTokens: 15, outputTokens: 4 },
    });
  });

  test('reports absent rather than zero when the response carries no usage', () => {
    expect(openAIAudioUsage({ text: 'hi' })).toEqual({ kind: 'absent' });
    // A duration-only response must NOT become a token estimate: new-api's
    // `1 min = 1000 tokens` rule is deliberately not adopted.
    expect(openAIAudioUsage({ text: 'hi', duration: 61 })).toEqual({ kind: 'absent' });
  });

  test('reports absent for a non-object body such as raw audio bytes', () => {
    expect(openAIAudioUsage(undefined)).toEqual({ kind: 'absent' });
    expect(openAIAudioUsage('binary')).toEqual({ kind: 'absent' });
  });

  test('rejects a token count that is not a safe non-negative integer', () => {
    expect(openAIAudioUsage({ usage: { input_tokens: -1 } })).toEqual({
      kind: 'invalid',
      issues: [{ code: 'invalid_token_count', path: ['inputTokens'] }],
    });
  });
});

describe('openai-audio passthrough bodies', () => {
  test('a speech response of raw audio bytes yields no usage and no failure', () => {
    // /v1/audio/speech returns binary audio, not JSON or SSE. The body reaches
    // usageFromJson only via the SSE observer fallback, which must not invent a row.
    const mp3 = new TextDecoder().decode(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x0a]));
    expect(extractPassthroughObservation(ProviderProtocol.OpenAIAudio, mp3)).toEqual({});
  });

  test('a transcription JSON body still bills its reported tokens', () => {
    expect(
      extractPassthroughObservation(
        ProviderProtocol.OpenAIAudio,
        JSON.stringify({ text: 'hi', usage: { type: 'tokens', input_tokens: 12, output_tokens: 3 } }),
      ),
    ).toEqual({ usage: { inputTokens: 12, outputTokens: 3 } });
  });
});
