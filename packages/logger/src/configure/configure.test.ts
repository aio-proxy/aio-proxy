import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLogger, reset } from '@logtape/logtape';

import { configureLogging, isLoggingConfigured } from '.';
import { toLogTapeLevel } from '../levels';

afterEach(async () => {
  await reset();
});

describe('toLogTapeLevel', () => {
  test('maps SDK levels to LogTape levels', () => {
    expect(toLogTapeLevel('debug')).toBe('debug');
    expect(toLogTapeLevel('info')).toBe('info');
    expect(toLogTapeLevel('warn')).toBe('warning');
    expect(toLogTapeLevel('error')).toBe('error');
  });
});

describe('configureLogging', () => {
  test('defaults to info and uses the default console routing', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => undefined);

    expect(isLoggingConfigured()).toBe(false);
    await configureLogging({ dir: '/unused/when-disabled' });
    expect(isLoggingConfigured()).toBe(true);
    const logger = getLogger(['aio-proxy', 'test']);
    logger.debug('hidden');
    logger.info('visible');

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('"message":"visible"');
    info.mockRestore();
  });

  test('writes daily JSON lines with structured properties', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-logger-'));
    const info = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await configureLogging({ dir, enabled: true });
      getLogger(['aio-proxy', 'test']).info('written', { requestId: 'request-1' });
      await reset();

      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const records = readFileSync(join(dir, files[0]!), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ message: 'written', properties: { requestId: 'request-1' } });
    } finally {
      info.mockRestore();
      rmSync(dir, { force: true, recursive: true });
    }
  });

  // 抓包面板读的是这个文件，而且读的就是刚发生的那个请求。默认缓冲下这里会读到空文件：
  // 断言「不 reset、不等待就能读到」是这条路径唯一的护栏，别改成去读 bufferSize 选项。
  test('makes a debug line readable from the file without waiting for a flush', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-logger-debug-'));
    const debug = spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      await configureLogging({ dir, enabled: true, level: 'debug' });
      getLogger(['aio-proxy', 'test']).debug('captured', { requestId: 'request-1' });

      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(dir, files[0]!), 'utf8')).toContain('"requestId":"request-1"');
    } finally {
      debug.mockRestore();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
