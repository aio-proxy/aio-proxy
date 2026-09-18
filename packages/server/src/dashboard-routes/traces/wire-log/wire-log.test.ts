import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DashboardTraceWireResponseSchema } from '@aio-proxy/types';
import { format } from 'date-fns';

import { readTraceWireLog } from '.';

const REQUEST_ID = 'request-a';
const STARTED_AT = new Date('2026-07-27T08:00:00.000Z');
const DEBUG_LOGGING = { enabled: true, level: 'debug', retentionDays: 7 } as const;

/** `jsonLinesFormatter` 的真实形状：message 是属性的 JSON 文本，属性原样放在 properties 里。 */
function logLine(properties: Record<string, unknown>): string {
  return `${JSON.stringify({
    '@timestamp': STARTED_AT.toISOString(),
    level: 'DEBUG',
    message: JSON.stringify(properties),
    logger: 'aio-proxy.server',
    properties,
  })}\n`;
}

async function logDirWith(lines: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-wire-log-'));
  await Bun.write(join(dir, `${format(STARTED_AT, 'yyyy-MM-dd')}.log`), lines);
  return dir;
}

async function readFrom(logDir: string) {
  const response = await readTraceWireLog({
    requestId: REQUEST_ID,
    startedAt: STARTED_AT,
    logging: DEBUG_LOGGING,
    logDir,
  });
  return DashboardTraceWireResponseSchema.parse(response);
}

const inboundSnapshot = logLine({
  event: 'request.inbound_snapshot',
  requestId: REQUEST_ID,
  inboundProtocol: 'openai-response',
  method: 'POST',
  url: 'https://proxy.test/v1/responses',
  headers: { 'content-type': 'application/json', authorization: '[REDACTED]' },
});

function attemptLines(attemptIndex: number, providerId: string): string {
  const identity = { requestId: REQUEST_ID, attemptIndex, providerId, modelId: 'gpt-5' };
  return [
    logLine({
      event: 'request.upstream_snapshot',
      ...identity,
      method: 'POST',
      url: `https://${providerId}.test/v1/responses`,
      headers: { authorization: '[REDACTED]' },
    }),
    logLine({ event: 'request.body_chunk', ...identity, direction: 'upstream_request', sequence: 0, text: '{"in":1}' }),
    logLine({
      event: 'request.body_terminal',
      ...identity,
      direction: 'upstream_request',
      sequence: 1,
      byteLength: 8,
      outcome: 'complete',
    }),
    logLine({
      event: 'request.upstream_result',
      ...identity,
      durationMs: 12,
      outcome: 'response',
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    logLine({ event: 'request.body_chunk', ...identity, direction: 'upstream_response', sequence: 0, text: 'out' }),
    logLine({
      event: 'request.body_terminal',
      ...identity,
      direction: 'upstream_response',
      sequence: 1,
      byteLength: 3,
      outcome: 'complete',
    }),
  ].join('');
}

describe('readTraceWireLog', () => {
  test('rebuilds the inbound hop and every attempt hop in order', async () => {
    const dir = await logDirWith(
      [
        inboundSnapshot,
        logLine({
          event: 'request.body_chunk',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 0,
          text: '{"model":"gpt-5"}',
        }),
        logLine({
          event: 'request.body_terminal',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 1,
          byteLength: 17,
          outcome: 'complete',
        }),
        attemptLines(0, 'provider-a'),
        attemptLines(1, 'provider-b'),
      ].join(''),
    );

    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    expect(body.available).toBe(true);
    expect(body.hops.map((hop) => hop.id)).toEqual(['inbound', 'attempt-0', 'attempt-1']);
    expect(body.hops[0]).toEqual({
      id: 'inbound',
      kind: 'inbound',
      request: {
        method: 'POST',
        url: 'https://proxy.test/v1/responses',
        headers: { 'content-type': 'application/json', authorization: '[REDACTED]' },
        body: { text: '{"model":"gpt-5"}', byteLength: 17, outcome: 'complete' },
      },
    });
    expect(body.hops[1]).toEqual({
      id: 'attempt-0',
      kind: 'attempt',
      attemptIndex: 0,
      providerId: 'provider-a',
      modelId: 'gpt-5',
      request: {
        method: 'POST',
        url: 'https://provider-a.test/v1/responses',
        headers: { authorization: '[REDACTED]' },
        body: { text: '{"in":1}', byteLength: 8, outcome: 'complete' },
      },
      response: {
        statusCode: 200,
        durationMs: 12,
        headers: { 'content-type': 'text/event-stream' },
        body: { text: 'out', byteLength: 3, outcome: 'complete' },
      },
    });
    expect(body.hops[2]?.providerId).toBe('provider-b');
  });

  test('orders body chunks by sequence, ignores other requests, and survives a half-written last line', async () => {
    const chunk = (sequence: number, text: string) =>
      logLine({ event: 'request.body_chunk', requestId: REQUEST_ID, direction: 'inbound', sequence, text });
    const dir = await logDirWith(
      [
        inboundSnapshot,
        chunk(2, 'c'),
        chunk(0, 'a'),
        chunk(1, 'b'),
        logLine({
          event: 'request.body_chunk',
          requestId: 'request-other',
          direction: 'inbound',
          sequence: 0,
          text: 'LEAK',
        }),
        logLine({ event: 'request.rejected', requestId: REQUEST_ID, statusCode: 400 }),
        // direction 认不出来的 body 事件不该凭空造出一个空的 attempt 跳。
        logLine({ event: 'request.body_chunk', requestId: REQUEST_ID, attemptIndex: 0, sequence: 0, text: 'GHOST' }),
        '{"@timestamp":"2026-07-27T08:00:00.000Z","level":"DEBUG","prop',
      ].join(''),
    );

    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    expect(body.hops).toHaveLength(1);
    expect(body.hops[0]?.request?.body?.text).toBe('abc');
  });

  // 一条抓包行可以比流的一个分块还长（Bun 大约 512 KB 一块），carry buffer 必须把跨块的
  // 半行接回去 —— 这个用例是它唯一的护栏。
  test('reassembles a line that spans stream chunks', async () => {
    const filler = 'x'.repeat(1_500_000);
    const dir = await logDirWith(
      [
        logLine({
          event: 'request.body_chunk',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 0,
          text: `head${filler}tail`,
        }),
        logLine({
          event: 'request.body_terminal',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 1,
          byteLength: filler.length + 8,
          outcome: 'complete',
        }),
      ].join(''),
    );

    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    const text = body.hops[0]?.request?.body?.text ?? '';
    expect(text).toHaveLength(filler.length + 8);
    expect(text.startsWith('head')).toBe(true);
    expect(text.endsWith('tail')).toBe(true);
    expect(body.hops[0]?.request?.body?.outcome).toBe('complete');
  });

  test('skips the file entirely for a trace without a request id', async () => {
    const dir = await logDirWith(inboundSnapshot);
    const body = DashboardTraceWireResponseSchema.parse(
      await readTraceWireLog({ requestId: '', startedAt: STARTED_AT, logging: DEBUG_LOGGING, logDir: dir }),
    );
    rmSync(dir, { force: true, recursive: true });

    expect(body).toEqual({ available: true, hops: [] });
  });

  test('reports an upstream exception as the hop error type', async () => {
    const dir = await logDirWith(
      logLine({
        event: 'request.upstream_result',
        requestId: REQUEST_ID,
        attemptIndex: 0,
        providerId: 'provider-a',
        modelId: 'gpt-5',
        durationMs: 7,
        outcome: 'exception',
        errorType: 'TypeError',
      }),
    );

    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    expect(body.hops[0]?.response).toEqual({ errorType: 'TypeError', durationMs: 7 });
  });

  test.each([
    [{ enabled: false, level: 'debug' }, 'disabled'],
    [{ enabled: true, level: 'info' }, 'level'],
  ] as const)('refuses to read when logging is %o', async (logging, reason) => {
    const dir = await logDirWith(inboundSnapshot);
    const body = DashboardTraceWireResponseSchema.parse(
      await readTraceWireLog({ requestId: REQUEST_ID, startedAt: STARTED_AT, logging, logDir: dir }),
    );
    rmSync(dir, { force: true, recursive: true });

    expect(body).toEqual({ available: false, reason, hops: [] });
  });

  test('reports a rotated-away day as missing with the retention window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-wire-log-empty-'));
    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    expect(body).toEqual({ available: false, reason: 'missing', retentionDays: 7, hops: [] });
  });
});
