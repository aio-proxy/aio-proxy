import { describe, expect, test } from 'bun:test';

import type { CredentialPort, ModelCatalog, RuntimeContext } from '@aio-proxy/plugin-sdk';

import { CLAUDE_OAUTH_BETA } from '../oauth';
import type { ClaudeCredential } from '../schema';
import { createClaudeRuntime } from './runtime';

const credential: ClaudeCredential = {
  accessToken: 'current-token',
  refreshToken: 'refresh',
  expiresAt: Number.MAX_SAFE_INTEGER,
};

describe('Claude runtime', () => {
  test('is ProviderV4 language-model-only and sends OAuth inference headers', async () => {
    const calls: Request[] = [];
    const runtime = await createClaudeRuntime(context(), {
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(runtime.raw).toBeUndefined();
    expect(runtime.tokenCount).toBeUndefined();
    expect(() => runtime.provider.embeddingModel('claude-sonnet-5')).toThrow('embedding');
    const controller = new AbortController();
    await runtime.provider.languageModel('claude-sonnet-5').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      abortSignal: controller.signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer current-token');
    expect(
      calls[0]?.headers
        .get('anthropic-beta')
        ?.split(',')
        .map((value) => value.trim()),
    ).toContain(CLAUDE_OAUTH_BETA);
    expect(calls[0]?.headers.get('x-api-key')).toBeNull();
    expect(calls[0]?.headers.get('anthropic-api-key')).toBeNull();
    expect(JSON.stringify([...(calls[0]?.headers ?? new Headers())])).not.toContain('dynamic-credential');
  });
});

function context(): RuntimeContext<ClaudeCredential, Record<string, never>> {
  const catalog: ModelCatalog = {
    language: [{ id: 'claude-sonnet-5', extra: { protocol: 'anthropic' } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
  const port: CredentialPort<ClaudeCredential> = {
    read: async () => ({ revision: 1, value: credential }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
  return {
    credentials: port,
    options: {},
    catalog,
    fetch: globalThis.fetch,
  };
}
