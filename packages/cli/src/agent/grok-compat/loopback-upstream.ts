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
          return json({
            id: 'compat-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_compat',
                      type: 'function',
                      function: { name: 'exec', arguments: '{"command":"pwd"}' },
                    },
                  ],
                },
              },
            ],
          });
        }
        return json({
          id: 'compat-2',
          object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'compat-ok' } }],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
