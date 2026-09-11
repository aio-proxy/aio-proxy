import { createHash } from 'node:crypto';

export type GrokCompatHttpRecord = {
  readonly method: string;
  readonly path: string;
  readonly origin: string;
  readonly tokenFingerprint?: string;
};

function fingerprint(header: string | null): string | undefined {
  const match = /^Bearer\s+(\S+)/u.exec(header ?? '');
  if (match === null) return undefined;
  return createHash('sha256').update(match[1]!).digest('hex').slice(0, 12);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= events.length) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(sseChunk(events[index])));
        index += 1;
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
  );
}

export async function listenLoopbackUpstream(records: GrokCompatHttpRecord[]): Promise<{
  readonly origin: string;
  readonly stop: () => void;
}> {
  let completions = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const tokenFingerprint = fingerprint(request.headers.get('authorization'));
      records.push({
        method: request.method,
        path: url.pathname,
        origin: url.origin,
        ...(tokenFingerprint === undefined ? {} : { tokenFingerprint }),
      });
      if (url.pathname.endsWith('/models') && request.method === 'GET') {
        return json({
          object: 'list',
          data: [{ id: 'compat-grok-model', object: 'model', owned_by: 'aio-proxy-compat' }],
        });
      }
      if (url.pathname.endsWith('/chat/completions') && request.method === 'POST') {
        completions += 1;
        if (completions === 1) {
          return sse([
            {
              id: 'compat-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  finish_reason: null,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_compat',
                        type: 'function',
                        function: { name: 'exec', arguments: '' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'compat-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  finish_reason: null,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] },
                },
              ],
            },
            {
              id: 'compat-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  finish_reason: null,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] },
                },
              ],
            },
            {
              id: 'compat-1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }],
            },
          ]);
        }
        return sse([
          {
            id: 'compat-2',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: 'compat' } }],
          },
          {
            id: 'compat-2',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, finish_reason: null, delta: { content: '-ok' } }],
          },
          {
            id: 'compat-2',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
          },
        ]);
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
