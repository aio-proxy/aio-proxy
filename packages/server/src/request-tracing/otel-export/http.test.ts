import { afterEach, expect, test } from 'bun:test';

import { SpanStatusCode } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AlwaysOnSampler, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import type { ServerLog } from '../../server-log';
import { createOtelExportDelegator, type OtelDestination } from './delegator';
import { createDestinationProcessor } from './exporters';

type CapturedRequest = {
  method: string;
  url: string;
  contentType: string | null;
  contentEncoding: string | null;
  headers: Headers;
  body: Uint8Array;
};

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serviceName(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body['resourceSpans'])) return undefined;
  const resourceSpan = body['resourceSpans'][0];
  if (!isRecord(resourceSpan) || !isRecord(resourceSpan['resource'])) return undefined;
  const attributes = resourceSpan['resource']['attributes'];
  if (!Array.isArray(attributes)) return undefined;
  for (const attribute of attributes) {
    if (!isRecord(attribute) || attribute['key'] !== 'service.name' || !isRecord(attribute['value'])) continue;
    const name = attribute['value']['stringValue'];
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function startServer(respond: (request: Request, index: number) => Response | Promise<Response>): {
  readonly port: number;
  readonly captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: CapturedRequest = {
        method: request.method,
        url: `${url.pathname}${url.search}`,
        contentType: request.headers.get('content-type'),
        contentEncoding: request.headers.get('content-encoding'),
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      };
      captured.push(record);
      return respond(request, captured.length - 1);
    },
  });
  servers.push(server);
  return { port: server.port ?? 0, captured };
}

function tracesUrl(port: number, contentType: OtelDestination['contentType'] = 'json'): OtelDestination {
  return {
    url: `http://127.0.0.1:${port}/custom/traces`,
    contentType,
    headers: { Authorization: 'Bearer export-token' },
  };
}

async function flushExport(
  destinationsFor: (port: number) => readonly OtelDestination[],
  respond: (request: Request, index: number) => Response | Promise<Response>,
  logs: ServerLog[] = [],
  allowFlushFailure = false,
): Promise<{ readonly captured: CapturedRequest[]; readonly port: number }> {
  const { port, captured } = startServer(respond);
  const delegator = createOtelExportDelegator({
    logger: (entry) => logs.push(entry),
    createProcessor: createDestinationProcessor,
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'aio-proxy' }),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [delegator],
  });
  delegator.sync(destinationsFor(port));
  const span = provider.getTracer('@aio-proxy/server').startSpan('export-me');
  span.setAttribute('gen_ai.request.model', 'gpt-test');
  span.setAttribute('secret.prompt', 'sentinel-prompt');
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'sentinel-status' });
  span.end();
  const flushed = delegator.forceFlush();
  if (allowFlushFailure) await flushed.catch(() => undefined);
  else await flushed;
  return { captured, port };
}

const ok = (): Response => new Response(null, { status: 200 });

test('posts filtered JSON to the configured path with only configured headers', async () => {
  const { captured } = await flushExport((port) => [tracesUrl(port)], ok);

  expect(captured).toHaveLength(1);
  expect(captured[0]?.method).toBe('POST');
  expect(captured[0]?.url).toBe('/custom/traces');
  expect(captured[0]?.contentEncoding).toBeNull();
  expect(captured[0]?.headers.get('authorization')).toBe('Bearer export-token');
  expect(captured[0]?.headers.get('x-unconfigured')).toBeNull();
  const parsed: unknown = JSON.parse(new TextDecoder().decode(captured[0]?.body));
  const text = JSON.stringify(parsed);
  expect(text).toContain('export-me');
  expect(text).toContain('gen_ai.request.model');
  expect(text).not.toContain('sentinel-prompt');
  expect(text).not.toContain('sentinel-status');
  expect(serviceName(parsed)).toBe('aio-proxy');
});

test('posts protobuf that is not JSON', async () => {
  const { captured } = await flushExport((port) => [tracesUrl(port, 'protobuf')], ok);

  expect(captured[0]?.contentType).toBe('application/x-protobuf');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(captured[0]?.body);
  expect(text).toContain('export-me');
  expect(() => JSON.parse(text)).toThrow();
});

test('keeps the configured URL and no content-encoding when OTLP env vars say otherwise', async () => {
  const previousCompression = process.env.OTEL_EXPORTER_OTLP_COMPRESSION;
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'gzip';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1';
  try {
    const { captured } = await flushExport((port) => [tracesUrl(port)], ok);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('/custom/traces');
    expect(captured[0]?.contentEncoding).toBeNull();
  } finally {
    if (previousCompression === undefined) delete process.env.OTEL_EXPORTER_OTLP_COMPRESSION;
    else process.env.OTEL_EXPORTER_OTLP_COMPRESSION = previousCompression;
    if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
  }
});

test('sends one POST per identical destination', async () => {
  const { captured } = await flushExport((port) => [tracesUrl(port), tracesUrl(port)], ok);

  expect(captured).toHaveLength(2);
  expect(captured.every((request) => request.method === 'POST' && request.url === '/custom/traces')).toBe(true);
});

test('logs export_failed for HTTP 400 without the response body', async () => {
  const logs: ServerLog[] = [];
  const { captured, port } = await flushExport(
    (serverPort) => [tracesUrl(serverPort)],
    () => new Response('secret-body', { status: 400 }),
    logs,
    true,
  );

  expect(captured).toHaveLength(1);
  expect(logs).toHaveLength(1);
  const log = logs[0];
  expect(log).toMatchObject({
    event: 'otel.export',
    category: 'export_failed',
    index: 0,
    origin: `http://127.0.0.1:${port}`,
  });
  if (log?.statusCode !== undefined) expect(log.statusCode).toBe(400);
  expect(JSON.stringify(logs)).not.toContain('secret-body');
});

test('retries immediately when Retry-After is 0', async () => {
  let hits = 0;
  const { captured } = await flushExport(
    (port) => [tracesUrl(port)],
    () => {
      hits += 1;
      if (hits === 1) return new Response('busy', { status: 503, headers: { 'Retry-After': '0' } });
      return new Response(null, { status: 200 });
    },
  );

  expect(captured.length).toBeGreaterThanOrEqual(2);
});

test('logs partial_success once and does not retry', async () => {
  const logs: ServerLog[] = [];
  const { captured, port } = await flushExport(
    (serverPort) => [tracesUrl(serverPort)],
    () =>
      new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 1, errorMessage: 'secret-body' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    logs,
  );

  expect(captured).toHaveLength(1);
  expect(logs).toEqual([
    {
      event: 'otel.export',
      category: 'partial_success',
      index: 0,
      origin: `http://127.0.0.1:${port}`,
    },
  ]);
  expect(JSON.stringify(logs)).not.toContain('secret-body');
});
