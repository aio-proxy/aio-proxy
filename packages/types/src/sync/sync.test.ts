import { expect, test } from 'bun:test';

import {
  SyncApplyInputSchema,
  SyncCancelDetachInputSchema,
  SyncDetachInputSchema,
  SyncPreviewInputSchema,
  SyncRangeInputSchema,
  SyncStatusSchema,
} from './sync';

test('sync schemas accept typed requests and reject secret-bearing backend forms', () => {
  expect(SyncPreviewInputSchema.parse({ kind: 'join', providerId: 'work' })).toEqual({
    kind: 'join',
    providerId: 'work',
  });
  expect(
    SyncApplyInputSchema.parse({ previewId: 'preview', decisions: [{ objectId: 'object', choice: 'local' }] }),
  ).toEqual({ previewId: 'preview', decisions: [{ objectId: 'object', choice: 'local' }] });
  expect(
    SyncStatusSchema.parse({
      state: 'idle',
      backend: null,
      providers: [],
      pendingOperations: 0,
      lastSuccessAt: null,
    }),
  ).toMatchObject({ state: 'idle', backend: null });
  expect(SyncRangeInputSchema.parse({ providerId: 'work', included: false })).toEqual({
    providerId: 'work',
    included: false,
  });
  expect(SyncDetachInputSchema.parse({ providerId: 'work', loginSessionId: 'session' })).toEqual({
    providerId: 'work',
    loginSessionId: 'session',
  });
  expect(SyncCancelDetachInputSchema.parse({ providerId: 'work' })).toEqual({ providerId: 'work' });
  expect(() => SyncRangeInputSchema.parse({ providerId: 'work', included: true })).toThrow();
});
