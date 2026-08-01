import http2 from 'node:http2';

import { type ConnectFrame, ConnectFrameDecoder } from './frame';

export const CURSOR_API_URL = 'https://api2.cursor.sh';
export const CURSOR_CLIENT_VERSION = 'cli-2026.01.09-231024f';
export const CURSOR_RUN_PATH = '/agent.v1.AgentService/Run';
export const CURSOR_GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';

export type CursorH2Stream = {
  write(frame: Uint8Array): void;
  end(): void;
  frames: AsyncIterable<ConnectFrame>;
  trailers: Promise<Record<string, string>>;
};

export type CursorTransport = {
  openRun(input: {
    readonly accessToken: string;
    readonly baseUrl?: string;
    readonly signal?: AbortSignal;
  }): Promise<CursorH2Stream>;
  unary(input: {
    readonly path: string;
    readonly headers: Record<string, string>;
    readonly body: Uint8Array;
    readonly baseUrl?: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<{ status: number; body: Uint8Array }>;
};

export function buildRunHeaders(input: {
  readonly accessToken: string;
  readonly requestId?: string;
  readonly baseUrl?: string;
}): Record<string, string> {
  return {
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    te: 'trailers',
    authorization: `Bearer ${input.accessToken}`,
    'x-ghost-mode': 'true',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-request-id': input.requestId ?? crypto.randomUUID(),
  };
}

export function buildDiscoveryHeaders(input: { readonly accessToken: string }): Record<string, string> {
  return {
    'content-type': 'application/proto',
    te: 'trailers',
    authorization: `Bearer ${input.accessToken}`,
    'x-ghost-mode': 'true',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
  };
}

export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ERR_HTTP2_ERROR' && /h2 is not supported/i.test(message)) {
    return new Error(
      `Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
        'This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate h2 via ALPN — ' +
        'typically an ALPN-stripping TLS-intercepting proxy. Front the provider with a local HTTP/2 bridge ' +
        'and set the Cursor baseUrl to it.',
    );
  }
  return error;
}

type FrameSink = {
  readonly iterable: AsyncIterable<ConnectFrame>;
  push(chunk: Uint8Array): void;
  finish(): void;
  fail(error: unknown): void;
};

function createFrameSink(): FrameSink {
  const decoder = new ConnectFrameDecoder();
  const queue: ConnectFrame[] = [];
  let done = false;
  let failure: unknown;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    push(chunk) {
      for (const frame of decoder.push(chunk)) queue.push(frame);
      notify();
    },
    finish() {
      done = true;
      notify();
    },
    fail(error) {
      failure = error ?? new Error('Cursor run stream failed');
      done = true;
      notify();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (failure) throw failure;
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

function normalizeHeaders(headers: http2.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

export function createNodeHttp2Transport(dependencies?: { connect?: typeof http2.connect }): CursorTransport {
  const connect = dependencies?.connect ?? http2.connect;
  return {
    openRun({ accessToken, baseUrl = CURSOR_API_URL, signal }) {
      const session = connect(baseUrl);
      const sink = createFrameSink();
      const trailers = Promise.withResolvers<Record<string, string>>();
      let trailersSettled = false;
      const resolveTrailers = (value: Record<string, string>): void => {
        if (trailersSettled) return;
        trailersSettled = true;
        trailers.resolve(value);
      };
      session.on('error', (error) => sink.fail(mapH2TransportError(error, baseUrl)));
      const request = session.request({
        ':method': 'POST',
        ':path': CURSOR_RUN_PATH,
        ...buildRunHeaders({ accessToken }),
      });
      request.on('data', (chunk: Buffer) => sink.push(chunk));
      request.on('trailers', (received) => resolveTrailers(normalizeHeaders(received)));
      request.on('end', () => {
        resolveTrailers({});
        sink.finish();
      });
      request.on('error', (error) => {
        resolveTrailers({});
        sink.fail(mapH2TransportError(error, baseUrl));
      });
      if (signal) {
        if (signal.aborted) request.close();
        signal.addEventListener('abort', () => {
          request.close();
          resolveTrailers({});
          sink.fail(new Error('Cursor run aborted'));
        });
      }
      return Promise.resolve({
        write: (frame: Uint8Array) => {
          request.write(frame);
        },
        end: () => {
          request.end();
        },
        frames: sink.iterable,
        trailers: trailers.promise,
      });
    },
    unary({ path, headers, body, baseUrl = CURSOR_API_URL, timeoutMs, signal }) {
      const session = connect(baseUrl);
      const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Uint8Array }>();
      let settled = false;
      const settle = (run: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run();
      };
      const timer = setTimeout(() => {
        settle(() => {
          session.destroy();
          reject(new Error(`Cursor unary request to ${path} timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      session.on('error', (error) => settle(() => reject(mapH2TransportError(error, baseUrl))));
      const request = session.request({ ':method': 'POST', ':path': path, ...headers });
      const chunks: Buffer[] = [];
      let status = 0;
      request.on('response', (received) => {
        status = Number(received[':status'] ?? 0);
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () =>
        settle(() => {
          session.close();
          resolve({ status, body: new Uint8Array(Buffer.concat(chunks)) });
        }),
      );
      request.on('error', (error) =>
        settle(() => {
          session.close();
          reject(mapH2TransportError(error, baseUrl));
        }),
      );
      if (signal) {
        if (signal.aborted) request.close();
        signal.addEventListener('abort', () =>
          settle(() => {
            request.close();
            reject(new Error('Cursor unary request aborted'));
          }),
        );
      }
      if (body.length > 0) request.end(Buffer.from(body));
      else request.end();
      return promise;
    },
  };
}
