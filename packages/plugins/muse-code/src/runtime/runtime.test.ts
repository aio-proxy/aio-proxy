import { describe, expect, test } from 'bun:test';

import type { CredentialPort, ModelCatalog, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { MuseCodeCredential } from '../schema';
import { createMuseCodeDynamicFetch, createMuseCodeRuntime } from './runtime';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'minted-key',
};

describe('Muse Code runtime', () => {
  test('sends Responses traffic with the minted key and version header', async () => {
    const modelRequests: Request[] = [];
    const runtime = await createMuseCodeRuntime({
      credentials: port(),
      options: {},
      catalog: emptyCatalog(),
      fetch: (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
        expect(init?.aioProxy?.traffic ?? 'model').toBe('model');
        modelRequests.push(new Request(input, init));
        return Response.json(openAIResponse());
      }) as RuntimeFetch,
    });

    await runtime.provider.languageModel('muse-spark-1.3').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    expect(runtime.raw).toBeUndefined();
    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]?.url).toBe('https://api.meta.ai/v1/responses');
    expect(modelRequests[0]?.headers.get('authorization')).toBe('Bearer minted-key');
    expect(modelRequests[0]?.headers.get('x-api-version')).toBe('1.0.0');
    expect(modelRequests[0]?.headers.get('authorization')).not.toContain('oauth-secret');
  });

  test('rejects image and embedding when the catalog has none', async () => {
    const runtime = await createMuseCodeRuntime({
      credentials: port(),
      options: {},
      catalog: emptyCatalog(),
      fetch: globalThis.fetch,
    });
    expect(() => runtime.provider.imageModel('muse-image-1.0')).toThrow('image');
    expect(() => runtime.provider.embeddingModel('embed')).toThrow('embedding');
  });

  test('dynamic fetch does not remint or send the oauth token', async () => {
    let captured: Request | undefined;
    const dynamicFetch = createMuseCodeDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return new Response(null, { status: 200 });
      },
    });
    await dynamicFetch('https://api.meta.ai/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer dynamic-credential' },
      body: '{}',
    });
    expect(captured?.headers.get('authorization')).toBe('Bearer minted-key');
    expect(captured?.headers.get('x-api-version')).toBe('1.0.0');
  });
});

function port(): CredentialPort<MuseCodeCredential> {
  return {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('runtime must not refresh');
    },
  };
}

function emptyCatalog(): ModelCatalog {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

function openAIResponse() {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'muse-spark-1.3',
    output: [
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1,
    },
    user: null,
    metadata: {},
  };
}
