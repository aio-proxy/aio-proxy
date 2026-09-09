import { expect, test } from 'bun:test';

import { SyncApplyInputSchema, SyncPreviewInputSchema, SyncStatusSchema } from './sync';

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
});
