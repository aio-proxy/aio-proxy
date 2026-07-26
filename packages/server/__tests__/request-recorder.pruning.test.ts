import { describe, expect, test } from 'bun:test';

import { type RequestLogStore } from '@aio-proxy/core/db';

import { createRequestRecorder, type RequestSession } from '../src/request-recorder';

const fixedNow = new Date('2026-07-11T08:00:00.000Z');

describe('request recorder', () => {
  test('persistence failures are swallowed', () => {
    const store: RequestLogStore = {
      insertFinal() {
        throw new Error('database unavailable');
      },
      overview() {
        throw new Error('unused');
      },
      prune() {
        throw new Error('database unavailable');
      },
    };
    const request = createRequestRecorder({ store, now: () => fixedNow }).begin({
      inboundProtocol: 'openai-compatible',
      requestedModelId: 'mini',
    });

    expect(() => request.finish({ outcome: 'success' })).not.toThrow();
  });

  test('a logger failure cannot escape constructor pruning', () => {
    const store: RequestLogStore = {
      insertFinal() {},
      overview() {
        throw new Error('unused');
      },
      prune() {
        throw new Error('database unavailable');
      },
    };

    expect(() =>
      createRequestRecorder({
        store,
        now: () => fixedNow,
        logger() {
          throw new Error('logger unavailable');
        },
      }),
    ).not.toThrow();
  });

  test('a logger failure cannot escape lazy pruning or finish persistence', () => {
    let current = fixedNow;
    let pruneCalls = 0;
    const store: RequestLogStore = {
      insertFinal() {
        throw new Error('database unavailable');
      },
      overview() {
        throw new Error('unused');
      },
      prune() {
        pruneCalls += 1;
        if (pruneCalls > 1) {
          throw new Error('database unavailable');
        }
      },
    };
    const recorder = createRequestRecorder({
      store,
      now: () => current,
      logger() {
        throw new Error('logger unavailable');
      },
    });
    current = new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000);
    let request: RequestSession | undefined;

    expect(() => {
      request = recorder.begin({ inboundProtocol: 'anthropic', requestedModelId: 'mini' });
    }).not.toThrow();
    expect(request).toBeDefined();
    expect(() => request?.finish({ outcome: 'failure' })).not.toThrow();
  });

  test('prunes on construction and at most once per 24 hours', () => {
    let current = fixedNow;
    const cutoffs: Date[] = [];
    const store: RequestLogStore = {
      insertFinal() {},
      overview() {
        throw new Error('unused');
      },
      prune(cutoff) {
        cutoffs.push(cutoff);
      },
    };
    const recorder = createRequestRecorder({ store, now: () => current });

    recorder.begin({ inboundProtocol: 'openai-compatible', requestedModelId: 'one' });
    current = new Date(fixedNow.getTime() + 23 * 60 * 60 * 1000);
    recorder.begin({ inboundProtocol: 'openai-compatible', requestedModelId: 'two' });
    current = new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000);
    recorder.begin({ inboundProtocol: 'openai-compatible', requestedModelId: 'three' });

    expect(cutoffs).toEqual([
      new Date(fixedNow.getTime() - 45 * 24 * 60 * 60 * 1000),
      new Date(fixedNow.getTime() - 44 * 24 * 60 * 60 * 1000),
    ]);
  });
});
