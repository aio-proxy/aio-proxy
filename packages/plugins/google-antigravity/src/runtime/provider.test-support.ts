import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import type { CcaTransport } from './transport';

export function fixtureRuntime(transport: CcaTransport) {
  return { call: (context: LogicalRequestContext) => ({ context, transport }) };
}

export function captureTransport(response: unknown) {
  const calls: Parameters<CcaTransport['execute']>[0][] = [];
  return {
    calls,
    transport: {
      async execute(input) {
        calls.push(input);
        return Response.json({ response });
      },
    } satisfies CcaTransport,
  };
}

export function captureStreamTransport(events: readonly unknown[]) {
  const calls: Parameters<CcaTransport['execute']>[0][] = [];
  return {
    calls,
    transport: {
      async execute(input) {
        calls.push(input);
        return ccaSse(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: event })}\n\n`));
              }
              controller.close();
            },
          }),
        );
      },
    } satisfies CcaTransport,
  };
}

export function ccaSse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

export function textResponse(text: string) {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] };
}

export function callOptions() {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions: { aioProxy: { logicalRequest: logicalContext() } },
  } as never;
}

export function logicalContext(): LogicalRequestContext {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    session: { key: 'sha256:abc', source: 'transcript' },
  };
}

export function runtimeContext() {
  const credential = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 4_000_000_000_000,
    email: 'person@example.com',
    projectId: 'project',
  };
  return {
    credentials: {
      read: async () => ({ value: credential, revision: 1 }),
      refresh: async () => ({ status: 'superseded' as const, snapshot: { value: credential, revision: 1 } }),
    },
    options: {},
    catalog: {
      language: [{ id: 'claude-sonnet-4-6', extra: { antigravity: { apiProvider: 'anthropic' } } }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    },
  };
}

export async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
