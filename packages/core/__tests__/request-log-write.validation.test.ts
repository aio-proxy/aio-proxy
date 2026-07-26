import { describe, expect, test } from 'bun:test';

import { createRequestLogStore, now, openDb, rows, tempHome, usage } from './request-log.test-support';

describe('request log store', () => {
  test('rejects usage for non-success outcomes without persisting either row', () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      expect(() =>
        store.insertFinal({
          ...rows[1],
          usage: { providerId: 'provider', modelId: 'model' },
        }),
      ).toThrow('Only successful requests can include usage');
      expect(handle.sqlite.query('SELECT COUNT(*) AS count FROM request_log').get()).toEqual({ count: 0 });
      expect(handle.sqlite.query('SELECT COUNT(*) AS count FROM usage').get()).toEqual({ count: 0 });
    } finally {
      handle.close();
    }
  });

  test('rejects successful usage whose provider or model differs from the terminal route', () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      expect(() =>
        store.insertFinal({
          ...rows[0],
          usage: { providerId: 'different-provider', modelId: rows[0].finalModelId },
        }),
      ).toThrow('Usage provider and model must match the final route');
      expect(() =>
        store.insertFinal({
          ...rows[0],
          usage: { providerId: rows[0].finalProviderId, modelId: 'different-model' },
        }),
      ).toThrow('Usage provider and model must match the final route');
      expect(handle.sqlite.query('SELECT COUNT(*) AS count FROM request_log').get()).toEqual({ count: 0 });
      expect(handle.sqlite.query('SELECT COUNT(*) AS count FROM usage').get()).toEqual({ count: 0 });
    } finally {
      handle.close();
    }
  });

  test('keeps the request and usage insert atomic and enforces one terminal row per request', () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      handle.db
        .insert(usage)
        .values({
          id: 'existing-usage',
          requestId: 'atomic-request',
          providerId: 'provider',
          modelId: 'model',
          createdAt: now,
        })
        .run();

      expect(() =>
        store.insertFinal({
          requestId: 'atomic-request',
          inboundProtocol: 'openai-compatible',
          requestedModelId: 'model',
          outcome: 'success',
          finalProviderId: 'provider',
          finalModelId: 'model',
          attempts: [],
          startedAt: now,
          completedAt: now,
          durationMs: 0,
          usage: { providerId: 'provider', modelId: 'model' },
        }),
      ).toThrow();
      expect(handle.sqlite.query('SELECT COUNT(*) AS count FROM request_log').get()).toEqual({ count: 0 });

      store.insertFinal(rows[1]);
      expect(() => store.insertFinal(rows[1])).toThrow();
    } finally {
      handle.close();
    }
  });
});
