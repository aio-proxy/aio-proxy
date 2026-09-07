import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { REQUEST_BODY_LIMITS } from '../request';
import { type AudioCapability, defineAudioProtocolAdapter, isAudioProtocolAdapter } from './audio-adapter';

const errors = {
  requestError: () => undefined,
  modelNotFound: () => new Response(null, { status: 404 }),
  previousResponseConflict: () => new Response(null, { status: 409 }),
  tooLarge: () => new Response(null, { status: 413 }),
  unsupportedContentEncoding: () => new Response(null, { status: 415 }),
  unsupported: () => new Response(null, { status: 501 }),
  provider: () => undefined,
  rateLimited: () => new Response(null, { status: 429 }),
};

function adapter(capability: AudioCapability) {
  return defineAudioProtocolAdapter<{ model: string }, Record<never, never>>({
    capability,
    protocol: ProviderProtocol.OpenAIAudio,
    parse: async () => ({ model: 'tts-1' }),
    model: (request) => request.model,
    rawRequest: async (raw) => raw,
    audioInvocation: () => ({ kind: 'speech', speech: { text: 'hi' } }),
    audioResponse: async () => new Response(null, { status: 200 }),
    errors,
  });
}

describe('defineAudioProtocolAdapter', () => {
  test('freezes the adapter and keeps the declared capability', () => {
    const speech = adapter('speech');
    expect(Object.isFrozen(speech)).toBe(true);
    expect(speech.capability).toBe('speech');
    expect(adapter('transcription').capability).toBe('transcription');
  });

  test('fills the shared defaults and exposes no language or image surface', () => {
    const speech = adapter('speech');
    expect(speech.bodyLimits(new Request('https://proxy.test'), {})).toEqual(REQUEST_BODY_LIMITS);
    expect(speech.dimensions({ model: 'tts-1' }, {})).toEqual({});
    expect(speech.requestDiagnostics({ model: 'tts-1' }, {})).toEqual([]);
    expect(speech.wantsStream({ model: 'tts-1' }, {})).toBe(false);
    expect('modelInvocation' in speech).toBe(false);
    expect('imageJson' in speech).toBe(false);
  });

  test('recognizes both audio capabilities and rejects other ones', () => {
    expect(isAudioProtocolAdapter(adapter('speech'))).toBe(true);
    expect(isAudioProtocolAdapter(adapter('transcription'))).toBe(true);
    expect(isAudioProtocolAdapter({ capability: 'image' })).toBe(false);
    expect(isAudioProtocolAdapter({ capability: 'embedding' })).toBe(false);
  });
});
