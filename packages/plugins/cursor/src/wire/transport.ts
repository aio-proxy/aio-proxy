import http2 from 'node:http2';

import { type ConnectFrame, ConnectFrameDecoder } from './frame';

export const CURSOR_API_URL = 'https://api2.cursor.sh';
export const CURSOR_CLIENT_VERSION = 'cli-2026.01.09-231024f';
export const CURSOR_RUN_PATH = '/agent.v1.AgentService/Run';
export const CURSOR_GET_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';

export type CursorH2Stream = {
  write(frame: Uint8Array): void;
  end(): void;
  close(reason?: unknown): void;
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
  finish(validateEof: boolean): void;
  fail(error: unknown): void;
};

function createFrameSink(): FrameSink {
  const decoder = new ConnectFrameDecoder();
  const queue: ConnectFrame[] = [];
  let done = false;
  let failed = false;
  let failure: unknown;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    push(chunk) {
      if (done) return;
      for (const frame of decoder.push(chunk)) queue.push(frame);
      notify();
    },
    finish(validateEof) {
      if (done) return;
      if (validateEof) decoder.finish();
      done = true;
      notify();
    },
    fail(error) {
      if (done) return;
      failed = true;
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
          if (failed) throw failure;
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
      if (signal?.aborted) {
        return Promise.reject(
          signal.reason === undefined ? new Error('Cursor run aborted before connecting') : signal.reason,
        );
      }
      const session = connect(baseUrl);
      let request: http2.ClientHttp2Stream;
      try {
        request = session.request({
          ':method': 'POST',
          ':path': CURSOR_RUN_PATH,
          ...buildRunHeaders({ accessToken }),
        });
      } catch (error) {
        session.destroy();
        return Promise.reject(mapH2TransportError(error, baseUrl));
      }
      const sink = createFrameSink();
      const trailers = Promise.withResolvers<Record<string, string>>();
      let finished = false;
      let requestEnded = false;
      let receivedTrailers: Record<string, string> | undefined;
      const endRequest = (): void => {
        if (requestEnded) return;
        requestEnded = true;
        request.end();
      };
      const onAbort = (): void => {
        finish(signal?.reason === undefined ? new Error('Cursor run aborted') : signal.reason, true);
      };
      const finish = (error?: unknown, closeRequest = false, validateEof = false): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        let terminalError = error;
        if (terminalError === undefined) {
          try {
            sink.finish(validateEof);
          } catch (caught) {
            terminalError = caught;
            sink.fail(caught);
          }
        } else {
          sink.fail(terminalError);
        }
        trailers.resolve(terminalError === undefined ? (receivedTrailers ?? {}) : {});
        if (terminalError === undefined) {
          endRequest();
          if (closeRequest) request.close();
          session.close();
        } else {
          request.close();
          session.destroy();
        }
      };
      session.on('error', (error) => finish(mapH2TransportError(error, baseUrl), true));
      session.on('close', () => finish(new Error('Cursor HTTP/2 session closed before Run EOF'), true));
      request.on('data', (chunk: Buffer) => {
        try {
          sink.push(chunk);
        } catch (error) {
          finish(error, true);
        }
      });
      request.on('trailers', (received) => {
        if (!finished) receivedTrailers = normalizeHeaders(received);
      });
      request.on('end', () => finish(undefined, false, true));
      request.on('error', (error) => finish(mapH2TransportError(error, baseUrl), true));
      request.on('close', () => finish(new Error('Cursor Run request closed before response EOF'), true));
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      return Promise.resolve({
        write: (frame: Uint8Array) => {
          request.write(frame);
        },
        end: endRequest,
        close: (reason?: unknown) => finish(reason, true),
        frames: sink.iterable,
        trailers: trailers.promise,
      });
    },
    unary({ path, headers, body, baseUrl = CURSOR_API_URL, timeoutMs, signal }) {
      if (signal?.aborted) {
        return Promise.reject(
          signal.reason === undefined ? new Error('Cursor unary request aborted before connecting') : signal.reason,
        );
      }
      const session = connect(baseUrl);
      let request: http2.ClientHttp2Stream;
      try {
        request = session.request({ ':method': 'POST', ':path': path, ...headers });
      } catch (error) {
        session.destroy();
        return Promise.reject(mapH2TransportError(error, baseUrl));
      }
      const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Uint8Array }>();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        settle({
          error: signal?.reason === undefined ? new Error('Cursor unary request aborted') : signal.reason,
        });
      };
      const settle = (outcome: { value: { status: number; body: Uint8Array } } | { error: unknown }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if ('error' in outcome) {
          request.close();
          session.destroy();
          reject(outcome.error);
        } else {
          session.close();
          resolve(outcome.value);
        }
      };
      timer = setTimeout(
        () => settle({ error: new Error(`Cursor unary request to ${path} timed out after ${timeoutMs}ms`) }),
        timeoutMs,
      );
      session.on('error', (error) => settle({ error: mapH2TransportError(error, baseUrl) }));
      session.on('close', () => settle({ error: new Error('Cursor unary HTTP/2 session closed before response EOF') }));
      const chunks: Buffer[] = [];
      let status = 0;
      request.on('response', (received) => {
        status = Number(received[':status'] ?? 0);
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => settle({ value: { status, body: new Uint8Array(Buffer.concat(chunks)) } }));
      request.on('error', (error) => settle({ error: mapH2TransportError(error, baseUrl) }));
      request.on('close', () => settle({ error: new Error('Cursor unary request closed before response EOF') }));
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      if (!settled) {
        if (body.length > 0) request.end(Buffer.from(body));
        else request.end();
      }
      return promise;
    },
  };
}
