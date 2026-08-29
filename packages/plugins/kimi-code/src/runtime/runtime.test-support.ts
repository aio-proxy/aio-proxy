import type { CredentialPort, ModelCatalog } from '@aio-proxy/plugin-sdk';

import type { KimiCredential } from '../oauth';

export function validCredential(accessToken = 'access-token'): KimiCredential {
  return { accessToken, refreshToken: 'refresh-token', expiresAt: 4_000_000_000_000, deviceId: 'device-1' };
}

export function credentialPort(initial: KimiCredential) {
  let value = initial;
  const port: CredentialPort<KimiCredential> = {
    read: async () => ({ value, revision: 1 }),
    refresh: async (_revision, exchange) => {
      const next = await exchange({ value, revision: 1 }, new AbortController().signal);
      value = next.value;
      return { status: 'updated', snapshot: { value, revision: 2 } };
    },
  };
  return Object.assign(port, { current: () => value });
}

export function catalog(): ModelCatalog {
  return {
    language: [
      { id: 'openai-model', extra: { protocol: 'openai-compatible' } },
      { id: 'anthropic-model', extra: { protocol: 'anthropic' } },
      { id: 'raw-only-model' },
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

export function context(credential: KimiCredential, modelCatalog: ModelCatalog) {
  return { credentials: credentialPort(credential), options: {}, catalog: modelCatalog };
}

export function logicalContext() {
  return { requestId: 'request-1', session: { key: 'sha256:test' as const, source: 'transcript' as const } };
}

export function tokenCountInput(protocol: 'anthropic' | 'openai-compatible') {
  return {
    protocol,
    modelId: 'resolved-model',
    request: new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', messages: [] }),
    }),
    context: logicalContext(),
    invocation: { messages: [] },
  };
}
