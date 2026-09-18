import { AsyncLocalStorage } from 'node:async_hooks';

import type { LogLevel } from '@aio-proxy/plugin-sdk';
import { getTimeRotatingFileSink } from '@logtape/file';
import { ansiColorFormatter, configure, getConsoleSink, jsonLinesFormatter, type Sink } from '@logtape/logtape';

import { toLogTapeLevel } from '../levels';

export type LoggingConfig = {
  readonly enabled?: boolean;
  readonly dir: string;
  readonly retentionDays?: number;
  readonly level?: LogLevel;
};

const DAY_MS = 24 * 60 * 60 * 1000;
let loggingConfigured = false;

export function isLoggingConfigured(): boolean {
  return loggingConfigured;
}

export async function configureLogging(config: LoggingConfig): Promise<void> {
  const sinkIds = ['console'];
  const sinks: Record<string, Sink> = {
    console: getConsoleSink({
      formatter: process.stderr.isTTY === true ? ansiColorFormatter : jsonLinesFormatter,
    }),
  };

  if (config.enabled === true) {
    sinks['file'] = getTimeRotatingFileSink({
      directory: config.dir,
      formatter: jsonLinesFormatter,
      maxAgeMs: (config.retentionDays ?? 3) * DAY_MS,
      // debug 级别本身就是「我认了这个开销」的开关，而抓包面板要读的正是刚发生的那个请求。
      // 默认的 8 KB 缓冲 + 5s 间隔只在**下一次写入**时才兑现：空闲的代理上最后一个请求的
      // 抓包永远留在内存里，面板只能显示成「没有记录」。写穿一次性干掉整类陈旧问题
      // （空抓包和被悄悄截断的 body），不必再开一个 flush 入口。其余级别保持缓冲。
      ...(config.level === 'debug' ? { bufferSize: 0 } : {}),
    });
    sinkIds.push('file');
  }

  await configure({
    sinks,
    loggers: [
      {
        category: ['aio-proxy'],
        lowestLevel: toLogTapeLevel(config.level ?? 'info'),
        sinks: sinkIds,
      },
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  });
  loggingConfigured = true;
}
