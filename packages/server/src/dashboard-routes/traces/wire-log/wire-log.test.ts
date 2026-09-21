import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DashboardTraceWireResponseSchema } from '@aio-proxy/types';
import { format } from 'date-fns';

import { readTraceWireLog } from '.';
import { applyWireEvent, createHopDrafts, finalizeHops, type HopDrafts } from './build-hops';

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

function attemptLines(
  attemptIndex: number,
  providerId: string,
  extras?: { readonly sendIndex?: number; readonly requestText?: string; readonly responseText?: string },
): string {
  const requestText = extras?.requestText ?? '{"in":1}';
  const responseText = extras?.responseText ?? 'out';
  const identity = {
    requestId: REQUEST_ID,
    attemptIndex,
    providerId,
    modelId: 'gpt-5',
    ...(extras?.sendIndex === undefined ? {} : { sendIndex: extras.sendIndex }),
  };
  return [
    logLine({
      event: 'request.upstream_snapshot',
      ...identity,
      method: 'POST',
      url: `https://${providerId}.test/v1/responses`,
      headers: { authorization: '[REDACTED]' },
    }),
    logLine({
      event: 'request.body_chunk',
      ...identity,
      direction: 'upstream_request',
      sequence: 0,
      text: requestText,
    }),
    logLine({
      event: 'request.body_terminal',
      ...identity,
      direction: 'upstream_request',
      sequence: 1,
      byteLength: requestText.length,
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
    logLine({
      event: 'request.body_chunk',
      ...identity,
      direction: 'upstream_response',
      sequence: 0,
      text: responseText,
    }),
    logLine({
      event: 'request.body_terminal',
      ...identity,
      direction: 'upstream_response',
      sequence: 1,
      byteLength: responseText.length,
      outcome: 'complete',
    }),
  ].join('');
}

function applyChunk(drafts: HopDrafts, sequence: number, text: string): void {
  applyWireEvent(drafts, { event: 'request.body_chunk', requestId: REQUEST_ID, direction: 'inbound', sequence, text });
}

/** 草稿这一刻真正攥在手里的字符数：不是返回值的大小，是读取过程中的驻留量。 */
function retainedChars(drafts: HopDrafts): number {
  return [...drafts.values()]
    .flatMap((draft) => [draft.requestBody, draft.responseBody])
    .reduce((total, body) => total + (body?.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) ?? 0), 0);
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

  // 进程正好在 JSON 和换行之间被杀掉：最后一行是完整的，只是没有结尾的 `\n`。上面那个
  // 半行夹具是读不出来的碎片，删掉收尾的 flush 也照样绿；这一条才分得清「解析后被丢掉」
  // 和「根本没解析」。
  test('keeps a complete last line that has no trailing newline', async () => {
    const dir = await logDirWith(
      inboundSnapshot +
        logLine({
          event: 'request.body_chunk',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 0,
          text: '{"last":true}',
        }).trimEnd(),
    );

    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    expect(body.hops[0]?.request?.body?.text).toBe('{"last":true}');
  });

  // 一条抓包行可以比流的一个分块还长（Bun 大约 512 KB 一块），carry buffer 必须把跨块的
  // 半行接回去 —— 这个用例是它唯一的护栏。填充量要留在单跳 body 上限以内，否则测的就
  // 变成裁剪而不是重组了。
  test('reassembles a line that spans stream chunks', async () => {
    const filler = 'x'.repeat(900_000);
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
    expect(body.hops[0]?.request?.body?.truncated).toBeUndefined();
  });

  // 抓包是诊断视图：一个流式大 body 原样返回能让代理多吃几百 MB、再把同样大的 JSON
  // 推给浏览器。裁剪必须发生在读取侧，而 byteLength 还得报日志里的真实大小。
  test('caps the body it keeps per direction and says it was truncated', async () => {
    const half = 'y'.repeat(700_000);
    const identity = { requestId: REQUEST_ID, attemptIndex: 0, providerId: 'provider-a', modelId: 'gpt-5' };
    const dir = await logDirWith(
      [
        logLine({ event: 'request.body_chunk', requestId: REQUEST_ID, direction: 'inbound', sequence: 0, text: half }),
        logLine({ event: 'request.body_chunk', requestId: REQUEST_ID, direction: 'inbound', sequence: 1, text: half }),
        logLine({
          event: 'request.body_terminal',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 2,
          byteLength: half.length * 2,
          outcome: 'complete',
        }),
        // 预算是每跳每方向各一份：响应方向不该和入站请求共用同一份，否则第二个方向会拿到
        // 一个已经花光的预算、在面板上显示成空的。
        logLine({ event: 'request.body_chunk', ...identity, direction: 'upstream_response', sequence: 0, text: half }),
        logLine({ event: 'request.body_chunk', ...identity, direction: 'upstream_response', sequence: 1, text: half }),
        logLine({
          event: 'request.body_terminal',
          ...identity,
          direction: 'upstream_response',
          sequence: 2,
          byteLength: half.length * 2,
          outcome: 'complete',
        }),
      ].join(''),
    );

    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    expect(body.hops[0]?.request?.body?.text).toHaveLength(1_048_576);
    expect(body.hops[0]?.request?.body?.truncated).toBe(true);
    expect(body.hops[0]?.request?.body?.byteLength).toBe(1_400_000);
    expect(body.hops[1]?.response?.body?.text).toHaveLength(1_048_576);
    expect(body.hops[1]?.response?.body?.truncated).toBe(true);
  });

  // 预算必须在读取时就兑现。只在 finalize 裁的话，浏览器收到的是 1 MB，代理自己却把日志里
  // 那 100 MB 整个攥在草稿里 —— 而它还在服务线上流量。这里看的是草稿留了多少，不是返回了多少。
  test('bounds what it retains while reading, not only what it returns', () => {
    const drafts = createHopDrafts();
    const chunk = 'z'.repeat(100_000);
    for (let sequence = 0; sequence < 64; sequence += 1) applyChunk(drafts, sequence, chunk);

    expect(retainedChars(drafts)).toBeLessThanOrEqual(1_048_576);
    expect(finalizeHops(drafts)[0]?.request?.body?.text).toHaveLength(1_048_576);
  });

  // 跨零点会并发读两个文件，分块可能乱序到达。裁剪一律从尾巴上来：留下的必须是 sequence
  // 最小的那一段，而不是「先到的那一段」。
  test('keeps the head of the body when chunks arrive out of order', () => {
    const drafts = createHopDrafts();
    applyChunk(drafts, 1, 'b'.repeat(1_048_576));
    applyChunk(drafts, 0, 'a'.repeat(16));

    const text = finalizeHops(drafts)[0]?.request?.body?.text ?? '';
    expect(text).toHaveLength(1_048_576);
    expect(text.startsWith('a'.repeat(16))).toBe(true);
  });

  // 上限数的是 code unit，正好切在代理对中间会剩下半个：JSON.stringify 会把它转义掉，
  // 面板在切口处画一个 U+FFFD。
  test('does not cut a surrogate pair in half at the cap', () => {
    const drafts = createHopDrafts();
    applyChunk(drafts, 0, `${'a'.repeat(1_048_575)}😀`);

    const text = finalizeHops(drafts)[0]?.request?.body?.text ?? '';
    expect(text.isWellFormed()).toBe(true);
    expect(text).toHaveLength(1_048_575);
  });

  test('skips the file entirely for a trace without a request id', async () => {
    // 这行自己的 requestId 也是空的：不短路的话它会被 `'' === ''` 匹配上、拼出一跳来，
    // 用正常的 REQUEST_ID 行做夹具的话删掉守卫测试照样绿，等于什么都没测。
    const dir = await logDirWith(
      logLine({
        event: 'request.inbound_snapshot',
        requestId: '',
        method: 'POST',
        url: 'https://proxy.test/v1/responses',
      }),
    );
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

  // 起止同一天 —— 线上绝大多数已结束的调用链 —— 只该开一个文件。返回 [started, ended]
  // 两份就是把同一个文件读两遍：每个事件应用两次，body 拼成 'beforebefore'。
  test('reads the day file once for a trace that started and ended on the same day', async () => {
    const dir = await logDirWith(
      inboundSnapshot +
        logLine({
          event: 'request.body_chunk',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 0,
          text: 'before',
        }),
    );
    const body = DashboardTraceWireResponseSchema.parse(
      await readTraceWireLog({
        requestId: REQUEST_ID,
        startedAt: STARTED_AT,
        endedAt: new Date(STARTED_AT.getTime() + 1_000),
        logging: DEBUG_LOGGING,
        logDir: dir,
      }),
    );
    rmSync(dir, { force: true, recursive: true });

    expect(body.hops[0]?.request?.body?.text).toBe('before');
  });

  // 23:59 开始、00:02 结束的流式请求：入站快照在昨天的文件里，响应分块和终止事件在今天的。
  // 只按起点开一个文件就只能拿到半截 body，而且响应里没有任何迹象说明少了东西。
  // 时刻用本地时间构造：文件名本来就是按本地日期滚的，测试不能自己换算成 UTC。
  test('scans the next day too when the request crossed local midnight', async () => {
    const startedAt = new Date(2026, 6, 27, 23, 59, 30);
    const endedAt = new Date(2026, 6, 28, 0, 2, 0);
    const chunk = (sequence: number, text: string) =>
      logLine({ event: 'request.body_chunk', requestId: REQUEST_ID, direction: 'inbound', sequence, text });
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-wire-log-midnight-'));
    await Bun.write(join(dir, `${format(startedAt, 'yyyy-MM-dd')}.log`), inboundSnapshot + chunk(0, 'before'));
    await Bun.write(join(dir, `${format(endedAt, 'yyyy-MM-dd')}.log`), chunk(1, 'after'));
    const read = async (ended: Date | undefined) =>
      DashboardTraceWireResponseSchema.parse(
        await readTraceWireLog({
          requestId: REQUEST_ID,
          startedAt,
          ...(ended === undefined ? {} : { endedAt: ended }),
          logging: DEBUG_LOGGING,
          logDir: dir,
        }),
      );

    const crossed = await read(endedAt);
    rmSync(dir, { force: true, recursive: true });

    expect(crossed.hops[0]?.request?.body?.text).toBe('beforeafter');
  });

  // 还在跑、且已经跨过本地零点：后半夜的分块写在今天的文件里。没有 endedAt 时
  // 用今天做临时终点，否则轮询一直只看见昨天那半截。
  test('scans through today while a request that started yesterday is still running', async () => {
    const now = new Date();
    const startedAt = new Date(now);
    startedAt.setDate(startedAt.getDate() - 1);
    startedAt.setHours(23, 59, 30, 0);
    const chunk = (sequence: number, text: string) =>
      logLine({ event: 'request.body_chunk', requestId: REQUEST_ID, direction: 'inbound', sequence, text });
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-wire-log-running-midnight-'));
    await Bun.write(join(dir, `${format(startedAt, 'yyyy-MM-dd')}.log`), inboundSnapshot + chunk(0, 'before'));
    await Bun.write(join(dir, `${format(now, 'yyyy-MM-dd')}.log`), chunk(1, 'after'));
    const body = DashboardTraceWireResponseSchema.parse(
      await readTraceWireLog({
        requestId: REQUEST_ID,
        startedAt,
        logging: DEBUG_LOGGING,
        logDir: dir,
      }),
    );
    rmSync(dir, { force: true, recursive: true });

    expect(body.hops[0]?.request?.body?.text).toBe('beforeafter');
  });

  test('reports a missing earlier day as a partial capture when a later file survives', async () => {
    const startedAt = new Date(2026, 6, 27, 23, 59, 30);
    const endedAt = new Date(2026, 6, 28, 0, 2, 0);
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-wire-log-partial-'));
    await Bun.write(
      join(dir, `${format(endedAt, 'yyyy-MM-dd')}.log`),
      inboundSnapshot +
        logLine({
          event: 'request.body_chunk',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 0,
          text: 'after',
        }) +
        logLine({
          event: 'request.body_terminal',
          requestId: REQUEST_ID,
          direction: 'inbound',
          sequence: 1,
          byteLength: 5,
          outcome: 'complete',
        }),
    );
    const body = DashboardTraceWireResponseSchema.parse(
      await readTraceWireLog({
        requestId: REQUEST_ID,
        startedAt,
        endedAt,
        logging: DEBUG_LOGGING,
        logDir: dir,
      }),
    );
    rmSync(dir, { force: true, recursive: true });

    expect(body).toMatchObject({ available: true, reason: 'partial', retentionDays: 7 });
    expect(body.hops[0]?.request?.body).toMatchObject({ text: 'after', outcome: 'complete' });
  });

  test('keeps two HTTP sends of the same attempt as separate hops', async () => {
    const first = attemptLines(0, 'provider-a', { sendIndex: 0, requestText: '{"in":1}', responseText: 'one' });
    const second = attemptLines(0, 'provider-a', { sendIndex: 1, requestText: '{"in":2}', responseText: 'two' });
    const dir = await logDirWith(inboundSnapshot + first + second);
    const body = await readFrom(dir);
    rmSync(dir, { force: true, recursive: true });

    expect(body.hops.map((hop) => hop.id)).toEqual(['inbound', 'attempt-0', 'attempt-0.1']);
    expect(body.hops[1]?.request?.body?.text).toBe('{"in":1}');
    expect(body.hops[1]?.response?.body?.text).toBe('one');
    expect(body.hops[2]?.request?.body?.text).toBe('{"in":2}');
    expect(body.hops[2]?.response?.body?.text).toBe('two');
    expect(body.hops[2]?.sendIndex).toBe(1);
  });
});

// 凭据头这份名单是后来才扩的（原来只有 authorization 和 x-api-key）。在那之前落盘的日志里
// cookie / api-key / x-goog-api-key 都是明文，而抓包接口读的正是磁盘上已有的那些行 ——
// 写侧的脱敏对它们一点用都没有，读出来必须按当前名单再过一遍。
test('redacts credentials that older log files recorded in plaintext', () => {
  const drafts = createHopDrafts();
  applyWireEvent(drafts, {
    event: 'request.inbound_snapshot',
    requestId: REQUEST_ID,
    method: 'POST',
    url: 'https://proxy.test/v1/messages?api_key=legacy-query-secret',
    headers: {
      cookie: 'session=legacy-cookie-secret',
      'api-key': 'legacy-azure-secret',
      'x-goog-api-key': 'legacy-google-secret',
      'x-observable': 'visible-header',
    },
  });

  const serialized = JSON.stringify(finalizeHops(drafts));

  expect(serialized).not.toContain('legacy-cookie-secret');
  expect(serialized).not.toContain('legacy-azure-secret');
  expect(serialized).not.toContain('legacy-google-secret');
  expect(serialized).not.toContain('legacy-query-secret');
  // 普通头照常可见，别把脱敏写成全抹。
  expect(serialized).toContain('visible-header');
});
