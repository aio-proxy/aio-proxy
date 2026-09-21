import { join } from 'node:path';

import type { DashboardTraceWireResponse } from '@aio-proxy/types';
import { eachDayOfInterval, format } from 'date-fns';

import { applyWireEvent, createHopDrafts, finalizeHops, type HopDrafts } from './build-hops';
import { wireEventFromLine } from './parse-line';

type WireLogging = {
  readonly enabled?: boolean;
  readonly dir?: string;
  readonly level?: string;
  readonly retentionDays?: number;
};

type ReadTraceWireLogInput = {
  readonly requestId: string;
  readonly startedAt: Date;
  /** 调用链的结束时刻；还在跑的话没有，就扫到今天（本地日期）。 */
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

  const files = logDatesOf(input).map((date) => Bun.file(join(input.logDir, `${date}.log`)));
  const present: Bun.BunFile[] = [];
  for (const file of files) if (await file.exists()) present.push(file);
  if (present.length === 0) {
    return {
      available: false,
      reason: 'missing',
      retentionDays: logging.retentionDays ?? DEFAULT_RETENTION_DAYS,
      hops: [],
    };
  }

  // 两个日志文件可以并发读：回调是同步的，事件进了草稿就立刻可回收，不会先攒成一个大数组。
  const drafts = createHopDrafts();
  await Promise.all(present.map((file) => scanWireEvents(file, input.requestId, drafts)));
  return { available: true, hops: finalizeHops(drafts) };
}

/**
 * getTimeRotatingFileSink 按**本地**日期滚文件；UTC 切片会在跨零点时读错文件。
 *
 * 23:59 开始、00:02 结束的流式请求，入站快照留在昨天的文件里，响应分块和终止事件
 * 在今天的：只按起点开一个文件会拿到一段被截断的 body，而且没有任何迹象说明少了东西。
 */
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
  const take = (line: string) => {
    const event = wireEventFromLine(line, requestId);
    // 解析出来当场灌进草稿：草稿自己带预算，这一行随后就是垃圾。
    if (event !== undefined) applyWireEvent(drafts, event);
  };
  for await (const chunk of file.stream()) {
    carry += decoder.decode(chunk, { stream: true });
    let newline = carry.indexOf('\n');
    while (newline >= 0) {
      take(carry.slice(0, newline));
      carry = carry.slice(newline + 1);
      newline = carry.indexOf('\n');
    }
  }
  take(carry + decoder.decode());
}
