import { afterEach, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';

import { configure, getLogger, reset } from '@logtape/logtape';

import { currentRequestId, withRequestId } from './request-context';

afterEach(async () => {
  await reset();
});

describe('withRequestId / currentRequestId', () => {
  test('exposes the id inside the scope and nothing outside', () => {
    expect(currentRequestId()).toBeUndefined();
    const inside = withRequestId('request-1', () => currentRequestId());
    expect(inside).toBe('request-1');
    expect(currentRequestId()).toBeUndefined();
  });

  test('inner scope overrides and restores the outer id', () => {
    withRequestId('outer', () => {
      expect(currentRequestId()).toBe('outer');
      withRequestId('inner', () => {
        expect(currentRequestId()).toBe('inner');
      });
      expect(currentRequestId()).toBe('outer');
    });
  });

  test('async continuations inherit the id', async () => {
    const seen = await Promise.all(
      ['a', 'b'].map((id) =>
        withRequestId(id, async () => {
          await Promise.resolve();
          return currentRequestId();
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b']);
  });

  test('enriches log records with requestId when contextLocalStorage is configured', async () => {
    const records: Record<string, unknown>[] = [];
    await configure({
      sinks: { capture: (record) => records.push(record.properties), meta: () => undefined },
      loggers: [
        { category: ['test'], sinks: ['capture'], lowestLevel: 'debug' },
        { category: ['logtape', 'meta'], sinks: ['meta'], lowestLevel: 'warning' },
      ],
      contextLocalStorage: new AsyncLocalStorage(),
    });
    withRequestId('request-9', () => getLogger(['test']).info('hello'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestId: 'request-9' });
  });
});
