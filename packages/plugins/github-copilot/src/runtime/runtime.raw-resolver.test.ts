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

  for (const scenario of [
    {
      protocol: 'openai-compatible' as const,
      modelId: 'gpt-chat',
      path: '/v1/completions',
      url: 'https://secret-host.example/v1/completions',
    },
    {
      protocol: 'openai-response' as const,
      modelId: 'gpt-response',
      path: '/v1/responses/compact',
      url: 'https://secret-host.example/v1/responses/compact',
    },
  ]) {
    test(`declines a non-advertised ${scenario.protocol} raw path so convert can run`, async () => {
      const credentials = credentialPort(validCredential('raw-token'));
      const runtime = await createGitHubCopilotRuntime({
        credentials: credentials.port,
        options: { deploymentType: 'github.com' },
        catalog: catalog(),
        fetch: forwardFetch,
      });

      expect(
        runtime.raw?.({ protocol: scenario.protocol, modelId: scenario.modelId, requestPath: scenario.path }),
      ).toBeUndefined();
      expect(runtime.raw?.({ protocol: scenario.protocol, modelId: scenario.modelId })).toBeDefined();
    });

    test(`declines a non-advertised ${scenario.protocol} raw path with a protocol-shaped 501`, async () => {
      let calls = 0;
      const credentials = credentialPort(validCredential('raw-token'));
      const runtime = await createGitHubCopilotRuntime({
        credentials: credentials.port,
        options: { deploymentType: 'github.com' },
        catalog: catalog(),
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      });
      const transport = runtime.raw?.({ protocol: scenario.protocol, modelId: scenario.modelId });
      const request = new Request(scenario.url, { method: 'POST', body: 'client-secret-body' });

      const response = await transport?.invoke(request);
      const body = JSON.stringify(await response?.json());

      expect(response?.status).toBe(501);
      expect(calls).toBe(0);
      expect(body).toContain('invalid_request_error');
      expect(body).not.toContain('secret');
    });
  }

  test('raw resolver still forwards advertised Responses create', async () => {
    const credentials = credentialPort(validCredential('raw-token'));
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: 'github.com' },
      catalog: catalog(),
      fetch: forwardFetch,
    });
    const transport = runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-response' });

    let captured: Request | undefined;
    const response = await withFetchMock(
      async (request, init) => {
        captured = new Request(request, init);
        return Response.json({ ok: true });
      },
      () =>
        transport?.invoke(
          new Request('http://localhost/v1/responses', { method: 'POST', body: '{}' }),
        ) as Promise<Response>,
    );

    expect(response.status).toBe(200);
    expect(captured?.url).toBe('https://api.githubcopilot.com/v1/responses');
  });

  test('declines embeddings so convert can run on the same candidate', async () => {
    const credentials = credentialPort(validCredential('raw-token'));
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: 'github.com' },
      catalog: catalog(),
      fetch: forwardFetch,
    });

    expect(
      runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-chat', capability: 'embedding' }),
    ).toBeUndefined();
    expect(runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-chat', capability: 'language' })).toBeDefined();
  });
});
