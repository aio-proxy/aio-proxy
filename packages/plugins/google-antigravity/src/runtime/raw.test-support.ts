import type { LogicalRequestContext, RawResolver } from '@aio-proxy/plugin-sdk';

export function resolve(resolver: RawResolver, protocol: Parameters<RawResolver>[0]['protocol']) {
  return resolver({ protocol, modelId: 'gemini-3-flash-agent' });
}

export function geminiRequest(
  method: 'generateContent' | 'streamGenerateContent',
  body: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request(`http://localhost/v1beta/models/gemini-3-flash-agent:${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(body),
  });
}

export function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

export function credentialSource() {
  const credential = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_900_000_000_000,
    email: 'person@example.com',
    projectId: 'project-1',
  };
  return { current: async () => credential, forceRefresh: async () => credential };
}

export function logicalContext(): LogicalRequestContext {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    session: { key: 'sha256:abc', source: 'transcript' },
  };
}
