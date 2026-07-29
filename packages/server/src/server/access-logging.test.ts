import { afterEach, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';

import { currentRequestId, withRequestId } from '@aio-proxy/logger';
import { honoLogger } from '@logtape/hono';
import { configure, reset, type LogRecord } from '@logtape/logtape';
import { Hono } from 'hono';

afterEach(async () => {
  await reset();
});

async function captureRecords(): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record) => records.push(record), meta: () => undefined },
    loggers: [
      { category: ['aio-proxy', 'server', 'http'], sinks: ['capture'], lowestLevel: 'info' },
      { category: ['logtape', 'meta'], sinks: ['meta'], lowestLevel: 'warning' },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  });
  return records;
}

// Mirrors the middleware wiring in server/server.ts createRoutes.
function accessLoggedApp(seen: { requestId?: string }): Hono {
  const app = new Hono();
  app.use((_context, next) => withRequestId(crypto.randomUUID(), next));
  app.use(
    honoLogger({
      category: ['aio-proxy', 'server', 'http'],
      level: 'info',
      format: 'structured-combined',
      context: {
        requestId: {
          headerNames: [],
          responseHeader: false,
          generate: () => currentRequestId() ?? crypto.randomUUID(),
        },
        include: ['requestId'],
      },
      skip: (context) => context.req.path === '/health' || context.req.path.startsWith('/dashboard/'),
    }),
  );
  // Stand-in for requestRecorder.begin(): it reuses the request-scoped id.
  app.get('/health', (context) => context.json({ status: 'ok' }));
  app.get('/dashboard/index', (context) => context.text('dash'));
  app.post('/v1/responses', (context) => {
    seen.requestId = currentRequestId() ?? crypto.randomUUID();
    return context.json({ ok: true });
  });
  return app;
}

describe('access logging middleware', () => {
  test('emits an http access record and unifies requestId with the handler', async () => {
    const records = await captureRecords();
    const seen: { requestId?: string } = {};
    const app = accessLoggedApp(seen);

    const response = await app.request('/v1/responses', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeNull();

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.category).toEqual(['aio-proxy', 'server', 'http']);
    expect(record.properties).toMatchObject({ method: 'POST', path: '/v1/responses', status: 200 });
    // Access line, handler read-back, and implicit context all share one id.
    expect(record.properties['requestId']).toBe(seen.requestId);
  });

  test('skips /health and /dashboard/*', async () => {
    const records = await captureRecords();
    const app = accessLoggedApp({});

    await app.request('/health');
    await app.request('/dashboard/index');

    expect(records).toHaveLength(0);
  });
});
