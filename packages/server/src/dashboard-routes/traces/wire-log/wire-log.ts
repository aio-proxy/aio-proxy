import { join } from 'node:path';

import type { DashboardTraceWireResponse } from '@aio-proxy/types';
import { format } from 'date-fns';

import { buildHops } from './build-hops';
import { wireEventFromLine, type WireEvent } from './parse-line';

type WireLogging = {
  readonly enabled?: boolean;
  readonly dir?: string;
  readonly level?: string;
  readonly retentionDays?: number;
};

type ReadTraceWireLogInput = {
  readonly requestId: string;
  readonly startedAt: Date;
  readonly logging: WireLogging | undefined;
  readonly logDir: string;
};

const DEFAULT_RETENTION_DAYS = 3;

/**
 * 从当天那一个滚动日志文件里按 `requestId` 捞出线级抓包，按跳重组。
 *
 * 不落库、不建索引：手动点开的排查视图，单文件单遍扫描的代价可以接受。真出现性能
 * 问题再谈索引。
 */
export async function readTraceWireLog(input: ReadTraceWireLogInput): Promise<DashboardTraceWireResponse> {
  const { logging } = input;
  if (logging?.enabled !== true) return { available: false, reason: 'disabled', hops: [] };
  if (logging.level !== 'debug') return { available: false, reason: 'level', hops: [] };
  // 没有 requestId 的调用链，扫再大的文件也匹配不到一行。
  if (input.requestId === '') return { available: true, hops: [] };

  // getTimeRotatingFileSink 按**本地**日期滚文件；UTC 切片会在跨零点时读错文件。
  const file = Bun.file(join(input.logDir, `${format(input.startedAt, 'yyyy-MM-dd')}.log`));
  if (!(await file.exists())) {
    return {
      available: false,
      reason: 'missing',
      retentionDays: logging.retentionDays ?? DEFAULT_RETENTION_DAYS,
      hops: [],
    };
  }

  return { available: true, hops: buildHops(await collectWireEvents(file, input.requestId)) };
}

async function collectWireEvents(file: Bun.BunFile, requestId: string): Promise<WireEvent[]> {
  const events: WireEvent[] = [];
  const decoder = new TextDecoder();
  // 日志文件可能有几百 MB，逐块解码 + carry buffer 切行，绝不整读进内存。
  let carry = '';
  const take = (line: string) => {
    const event = wireEventFromLine(line, requestId);
    if (event !== undefined) events.push(event);
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
  return events;
}
