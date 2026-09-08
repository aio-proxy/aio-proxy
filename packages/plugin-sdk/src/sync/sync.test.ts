import { expect, test } from 'bun:test';

import { SyncBackendError } from './sync';

test('SyncBackendError preserves its failure code', () => {
  const error = new SyncBackendError('outcome-unknown', 'The write may have reached storage');

  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe('outcome-unknown');
  expect(error.message).toBe('The write may have reached storage');
});
