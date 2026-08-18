import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';
import type { CallSettings, JSONValue, TextStreamPart, ToolSet } from 'ai';

import { createServer } from '#server-test-lifecycle';

export { createTempHomes } from './temporary-homes.test-support';

export const generateRequest = {
  contents: [{ role: 'user', parts: [{ text: 'Hello proxy' }] }],
};
export const jsonHeaders = { 'content-type': 'application/json' } as const;
export type ProviderSeenSettings = CallSettings & {
  readonly providerOptions?: {
    readonly google: {
      readonly safetySettings: JSONValue;
    };
  };
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

export class AbortStreamError extends Error {
  override readonly name = 'AbortError';
}

export function appWith(
  provider?: ApiProviderInstance | AiSdkProviderInstance,
  dbHome?: string,
): ReturnType<typeof createServer> {
  return createServer({
    config: { providers: {} },
    ...(dbHome === undefined ? {} : { dbHome }),
    providerInstances: provider === undefined ? [] : [provider],
  });
}

export function googleNativeProvider(passthrough: ApiProviderInstance['passthrough']): ApiProviderInstance {
  return {
    id: 'google',
    kind: 'api',
    models: ['gemini-2.5-flash'],
    alias: { 'gemini-2.5-flash': { model: 'gemini-2.5-flash', preserve: false } },
    protocol: ProviderProtocol.Gemini,
    endpointTransports: [{ protocol: ProviderProtocol.Gemini, passthrough }],
    passthrough,
  };
}

export function aiSdkProvider(invoke: AiSdkProviderInstance['invoke']): AiSdkProviderInstance {
  return {
    id: 'mock-ai',
    kind: 'ai-sdk',
    models: ['gemini-2.5-flash'],
    alias: { 'gemini-2.5-flash': { model: 'gemini-2.5-flash', preserve: false } },
    invoke,
  };
}

export function postGenerate(
  app: ReturnType<typeof createServer>,
  body: string | object = generateRequest,
  model = 'gemini-2.5-flash',
): Promise<Response> {
  return app.request(`/v1beta/models/${model}:generateContent`, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: jsonHeaders,
    method: 'POST',
  });
}

export function postStream(app: ReturnType<typeof createServer>): Promise<Response> {
  return app.request('/v1beta/models/gemini-2.5-flash:streamGenerateContent', {
    body: JSON.stringify(generateRequest),
    headers: jsonHeaders,
    method: 'POST',
  });
}
