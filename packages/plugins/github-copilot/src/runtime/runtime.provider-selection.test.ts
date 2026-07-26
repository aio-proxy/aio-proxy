import { describe, expect, test } from 'bun:test';

import { credentialPort, withFetchMock } from '../../__tests__/test-support';
import { createGitHubCopilotRuntime } from './runtime';
import { catalog, forwardFetch, validCredential } from './runtime.test-support';

describe('GitHub Copilot runtime', () => {
  test('selects language providers from canonical catalog protocol metadata', async () => {
    const credentials = credentialPort(validCredential('copilot-token'));
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: 'github.com' },
      catalog: catalog(),
    });

    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(runtime.provider.languageModel('gpt-chat').provider).toContain('openai-compatible');
    expect(runtime.provider.languageModel('claude').provider).toContain('anthropic');
    expect(runtime.provider.languageModel('gpt-response').provider).toContain('openai');
    expect(() => runtime.provider.languageModel('missing')).toThrow('missing');
  });

  test('dynamic provider fetch refreshes credentials without rebuilding the runtime', async () => {
    const refreshSignal = new AbortController().signal;
    const credentials = credentialPort(
      {
        githubToken: 'github-token',
        copilotToken: 'expired-token',
        expiresAt: 0,
        baseURL: 'https://stale.example',
      },
      refreshSignal,
    );
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: 'github.com' },
      catalog: catalog(),
      fetch: forwardFetch,
    });
    const calls: { url: URL; authorization: string | null; signal: AbortSignal | null }[] = [];

    await withFetchMock(
      async (input, init) => {
        const url = new URL(input.toString());
        if (url.pathname === '/copilot_internal/v2/token') {
          calls.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
            signal: init?.signal ?? null,
          });
          return Response.json({ token: 'refreshed-token', expires_at: 9_999_999_999 });
        }
        calls.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
          signal: init?.signal ?? null,
        });
        return Response.json({
          id: 'chatcmpl-test',
          created: 1,
          model: 'gpt-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
      async () => {
        await runtime.provider.languageModel('gpt-chat').doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        });
      },
    );

    expect(calls[0]?.url.pathname).toBe('/copilot_internal/v2/token');
    expect(calls[0]?.authorization).toBe('Bearer github-token');
    expect(calls[0]?.signal).toBe(refreshSignal);
    expect(calls[1]?.url.toString()).toBe('https://api.githubcopilot.com/chat/completions');
    expect(calls[1]?.authorization).toBe('Bearer refreshed-token');
    expect(credentials.current().value.copilotToken).toBe('refreshed-token');
  });
});
