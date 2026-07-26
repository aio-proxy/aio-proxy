import { describe, expect, test } from 'bun:test';

import { credentialPort, withFetchMock } from '../../__tests__/test-support';
import { createGitHubCopilotRuntime } from './runtime';
import { catalog, forwardFetch, validCredential } from './runtime.test-support';

describe('GitHub Copilot runtime', () => {
  test('raw resolver matches model protocol and preserves request details while rewriting origin', async () => {
    const credentials = credentialPort(validCredential('raw-token'));
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: 'github.com' },
      catalog: catalog(),
      fetch: forwardFetch,
    });

    expect(runtime.raw?.({ protocol: 'anthropic', modelId: 'gpt-chat' })).toBeUndefined();
    const transport = runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-chat' });
    expect(transport).toBeDefined();

    const controller = new AbortController();
    let captured: Request | undefined;
    let capturedSignal: AbortSignal | null | undefined;
    const response = await withFetchMock(
      async (request, init) => {
        capturedSignal = init?.signal;
        captured = new Request(request, init);
        return Response.json({ ok: true });
      },
      () =>
        transport?.invoke(
          new Request('http://localhost/v1/chat/completions?trace=1', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-client': 'kept' },
            body: JSON.stringify({ model: 'gpt-chat', messages: [] }),
            signal: controller.signal,
          }),
        ) as Promise<Response>,
    );

    expect(response.status).toBe(200);
    expect(captured?.url).toBe('https://api.githubcopilot.com/v1/chat/completions?trace=1');
    expect(captured?.method).toBe('POST');
    expect(capturedSignal).toBe(controller.signal);
    expect(captured?.headers.get('x-client')).toBe('kept');
    expect(captured?.headers.get('authorization')).toBe('Bearer raw-token');
    expect(captured?.headers.get('Copilot-Integration-Id')).toBe('vscode-chat');
    expect(await captured?.json()).toEqual({ model: 'gpt-chat', messages: [] });
  });
});
