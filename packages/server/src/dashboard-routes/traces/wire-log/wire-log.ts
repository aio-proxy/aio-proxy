import { join } from 'node:path';

import type { DashboardTraceWireResponse } from '@aio-proxy/types';
import { addDays, eachDayOfInterval, format } from 'date-fns';

import { applyWireEvent, createHopDrafts, finalizeHops, type HopDrafts } from './build-hops';
import { MAX_PARSE_LINE, MAX_PROPERTIES_CARRY, PROPERTIES_KEY, wireEventFromLine } from './parse-line';

type WireLogging = {
  readonly enabled?: boolean;
  readonly dir?: string;
  readonly level?: string;
  readonly retentionDays?: number;
};

type ReadTraceWireLogInput = {
  readonly requestId: string;
  readonly startedAt: Date;
  /** 调用链的结束时刻；还在跑的话没有，就扫到今天。已结束且正文未终态时再看本地下一天。 */
  readonly endedAt?: Date | undefined;
  readonly logging: WireLogging | undefined;
  readonly logDir: string;
};

const DEFAULT_RETENTION_DAYS = 3;

/**
 * 从滚动日志里按 `requestId` 捞出线级抓包，按跳重组。
 *
 * 不落库、不建索引：手动点开的排查视图，单遍扫描的代价可以接受。真出现性能问题再谈索引。
 */
export async function readTraceWireLog(input: ReadTraceWireLogInput): Promise<DashboardTraceWireResponse> {
  const { logging } = input;
  if (logging?.enabled !== true) return { available: false, reason: 'disabled', hops: [] };
  if (logging.level !== 'debug') return { available: false, reason: 'level', hops: [] };
  // 没有 requestId 的调用链，扫再大的文件也匹配不到一行。
  if (input.requestId === '') return { available: true, hops: [] };

  const expected = logDatesOf(input);
  const expectedFiles: Bun.BunFile[] = [];
  for (const date of expected) {
    const file = Bun.file(join(input.logDir, `${date}.log`));
    if (await file.exists()) expectedFiles.push(file);
  }
  const extra = await extraDayFile(input, expected);
  const retentionDays = logging.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (expectedFiles.length === 0 && extra === undefined) {
    return { available: false, reason: 'missing', retentionDays, hops: [] };
  }

  // 期望日可以并发读。下一天只在正文还没终态、或期望日整份都丢了时才扫，
  // 否则昨天已结束的调用链每次打开都要啃掉今天整份 debug 日志。
  const drafts = createHopDrafts();
  await Promise.all(expectedFiles.map((file) => scanWireEvents(file, input.requestId, drafts)));
  if (extra !== undefined && (expectedFiles.length === 0 || hopsNeedNextDay(finalizeHops(drafts)))) {
    await scanWireEvents(extra, input.requestId, drafts);
  }
  // 跨零点时昨天的文件可能已经按保留期滚掉了。只看「是不是一个都没有」会把后一天
  // 的终态当成完整抓包，半截请求体没有任何截断提示。
  return expectedFiles.length === expected.length
    ? { available: true, hops: finalizeHops(drafts) }
    : { available: true, reason: 'partial', retentionDays, hops: finalizeHops(drafts) };
}

/**
 * getTimeRotatingFileSink 按**本地**日期滚文件；UTC 切片会在跨零点时读错文件。
 *
 * 23:59 开始、00:02 结束的流式请求，入站快照留在昨天的文件里，响应分块和终止事件
 * 在今天的：只按起点开一个文件会拿到一段被截断的 body，而且没有任何迹象说明少了东西。
 *
 * 临近零点结算的 raw 失败会先写下 `endedAt`，正文分块/终态再写进下一天；调用方按
 * `endedAt` 扫的话永远看不到那天的文件。
 */
async function extraDayFile(
  input: ReadTraceWireLogInput,
  expected: readonly string[],
): Promise<Bun.BunFile | undefined> {
  if (input.endedAt === undefined) return undefined;
  const after = format(addDays(input.endedAt, 1), 'yyyy-MM-dd');
  if (expected.includes(after)) return undefined;
  const file = Bun.file(join(input.logDir, `${after}.log`));
  return (await file.exists()) ? file : undefined;
}

/** 期望日已经终态齐全就不必再扫下一天。 */
function hopsNeedNextDay(hops: DashboardTraceWireResponse['hops']): boolean {
  return hops.some((hop) => {
    if (bodyOpen(hop.request?.body) || bodyOpen(hop.response?.body)) return true;
    if (requestBodyPending(hop)) return true;
    return hop.kind === 'attempt' && hop.response?.body === undefined && hop.response?.errorType === undefined;
  });
}

function requestBodyPending(hop: DashboardTraceWireResponse['hops'][number]): boolean {
  if (hop.request === undefined || hop.request.body !== undefined) return false;
  const method = hop.request.method?.toUpperCase();
  // GET / HEAD 本来就没有请求体；旧日志也没终态，不能据此去扫下一天。
  if (method === 'GET' || method === 'HEAD') return false;
  // 已经有上游结果，请求体要么当时记过，要么不会再来。
  return hop.response === undefined;
}

function bodyOpen(body: { readonly outcome?: string } | undefined): boolean {
  return body !== undefined && body.outcome === undefined;
}

function logDatesOf(input: ReadTraceWireLogInput): string[] {
  const end = input.endedAt ?? new Date();
  const started = format(input.startedAt, 'yyyy-MM-dd');
  if (format(end, 'yyyy-MM-dd') <= started) return [started];
  return eachDayOfInterval({ start: input.startedAt, end }).map((day) => format(day, 'yyyy-MM-dd'));
}

async function scanWireEvents(file: Bun.BunFile, requestId: string, drafts: HopDrafts): Promise<void> {
  const decoder = new TextDecoder();
  // 日志文件可能有几百 MB，逐块解码 + carry buffer 切行，绝不整读进内存。
  let carry = '';
  // 超长行裁过 properties 之后丢掉换行前的尾巴，避免 carry 跟着涨到整段正文。
  let skipLine = false;
  const take = (line: string) => {
    const event = wireEventFromLine(line, requestId);
    // 解析出来当场灌进草稿：草稿自己带预算，这一行随后就是垃圾。
    if (event !== undefined) applyWireEvent(drafts, event);
  };
  const takeProperties = (end: number) => {
    const propertiesAt = carry.lastIndexOf(PROPERTIES_KEY, end);
    if (propertiesAt >= 0 && propertiesAt < end) {
      take(carry.slice(propertiesAt, Math.min(end, propertiesAt + MAX_PROPERTIES_CARRY)));
    }
  };
  const drain = () => {
    while (true) {
      const newline = carry.indexOf('\n');
      if (newline < 0) {
        shrinkIncompleteCarry();
        return;
      }
      takeProperties(newline);
      carry = carry.slice(newline + 1);
    }
  };
  const shrinkIncompleteCarry = () => {
    const propertiesAt = carry.lastIndexOf(PROPERTIES_KEY);
    if (propertiesAt < 0) {
      if (carry.length > MAX_PARSE_LINE) carry = carry.slice(1 - PROPERTIES_KEY.length);
      return;
    }
    if (carry.length - propertiesAt > MAX_PROPERTIES_CARRY) {
      take(carry.slice(propertiesAt, propertiesAt + MAX_PROPERTIES_CARRY));
      skipLine = true;
      carry = '';
      return;
    }
    if (propertiesAt > 0 && carry.length > MAX_PARSE_LINE) carry = carry.slice(propertiesAt);
  };
  for await (const chunk of file.stream()) {
    const decoded = decoder.decode(chunk, { stream: true });
    if (skipLine) {
      const newline = decoded.indexOf('\n');
      if (newline < 0) continue;
      skipLine = false;
      carry = decoded.slice(newline + 1);
    } else {
      carry += decoded;
    }
    drain();
  }
  if (!skipLine) take(carry + decoder.decode());
}
