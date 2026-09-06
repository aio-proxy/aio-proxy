import { expect, test } from 'bun:test';

import { ConfigSchema, type Provider, ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import { attachAudioTransports } from './materialize-audio';

function aiSdkConfig(packageName: string): Provider {
  const config = ConfigSchema.parse({
    providers: { sdk: { kind: 'ai-sdk', packageName, models: ['tts-1'] } },
  });
  return config.providers[0]!;
}

function apiConfig(protocol: string): Provider {
  const config = ConfigSchema.parse({
    providers: { api: { kind: 'api', protocol, baseURL: 'https://api.example.com', models: ['tts-1'] } },
  });
  return config.providers[0]!;
}

function languageOnlyInstance(kind: ProviderKind = ProviderKind.AiSdk): RuntimeProviderInstance {
  return {
    id: 'sdk',
    kind,
    enabled: true,
    capabilityIndex: { 'tts-1': new Set(['language'] as const) },
    model: {
      invoke() {
        throw new Error('unused');
      },
    },
  };
}

test('an @ai-sdk/openai provider gains both audio transports even though its index has no audio', () => {
  // The bridged package reports the OpenAI Responses target protocol, so the
  // capability index grants language only. Without this attachment the convert
  // path has no transport at all and every /v1/audio request 501s.
  const instance = attachAudioTransports(languageOnlyInstance(), { config: aiSdkConfig('@ai-sdk/openai') });
  expect(instance.speech).toBeDefined();
  expect(instance.transcription).toBeDefined();
});

test('an openai-compatible ai-sdk provider gains no audio transport', () => {
  // @ai-sdk/openai-compatible implements neither speechModel nor
  // transcriptionModel, so attaching a transport would admit the candidate to the
  // audio pool only to fail inside the AI SDK on every attempt.
  const instance = attachAudioTransports(languageOnlyInstance(), {
    config: aiSdkConfig('@ai-sdk/openai-compatible'),
  });
  expect(instance.speech).toBeUndefined();
  expect(instance.transcription).toBeUndefined();
});

test('an API provider gains no audio transport and keeps its raw passthrough', () => {
  // API providers reach audio through the same-protocol raw path only: an
  // `openai-audio` endpoint always matches raw.resolve, and one without such an
  // endpoint has no audio surface to convert against.
  const instance = attachAudioTransports(languageOnlyInstance(ProviderKind.Api), {
    config: apiConfig('openai-audio'),
  });
  expect(instance.speech).toBeUndefined();
  expect(instance.transcription).toBeUndefined();
});

test('keeps an already-attached transport rather than replacing it', () => {
  const speech = {
    invoke() {
      throw new Error('unused');
    },
  };
  const instance = attachAudioTransports(
    { ...languageOnlyInstance(), speech },
    { config: aiSdkConfig('@ai-sdk/openai') },
  );
  expect(instance.speech).toBe(speech);
});

test('does not load the AI SDK provider package until the transport is first invoked', async () => {
  // Eager loading at materialize time would import every configured provider's
  // package on startup. The image transport is lazy for the same reason.
  let loads = 0;
  const instance = attachAudioTransports(languageOnlyInstance(), {
    config: aiSdkConfig('@ai-sdk/openai'),
    loadProvider: async (packageName) => {
      loads += 1;
      expect(packageName).toBe('@ai-sdk/openai');
      return null;
    },
  });
  expect(loads).toBe(0);
  await expect(
    instance.speech?.invoke({ text: 'hi' }, { modelId: 'tts-1', logicalRequest: {} as never }),
  ).rejects.toThrow(/cannot build a V4 speechModel/);
  expect(loads).toBe(1);
});
