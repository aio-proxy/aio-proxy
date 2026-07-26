import type { AiSdkProviderInstance } from '@aio-proxy/core';
import type { TextStreamPart, ToolSet } from 'ai';

export { createTempHomes } from './temporary-homes.test-support';

export const responsesRequest = {
  model: 'gpt-4.1-mini',
  input: 'Say pong.',
  stream: true,
};
export { recorded } from './trace-recording.test-support';

export function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

export function aiSdkProvider(invoke: AiSdkProviderInstance['invoke']): AiSdkProviderInstance {
  return {
    id: 'mock-ai',
    kind: 'ai-sdk',
    models: ['gpt-4.1-mini'],
    alias: { 'gpt-4.1-mini': { model: 'gpt-4.1-mini', preserve: false } },
    invoke,
  };
}

export class AbortStreamError extends Error {
  override readonly name = 'AbortError';
}

export function unsupportedEnvelope(feature: string) {
  return {
    error: {
      code: 'unsupported_feature',
      message: `OpenAI Responses feature is not supported: ${feature}`,
      type: 'unsupported_feature',
    },
  };
}

export const unsupportedBeforeProviderInvocationCases = [
  {
    body: { ...responsesRequest, store: true },
    feature: 'store',
    name: 'store true',
  },
] as const;
