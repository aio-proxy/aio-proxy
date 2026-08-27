import { expect, test } from 'bun:test';

import { EDITS_MULTIPART_ENCODED_LIMIT } from '../../../core/src/ingress/openai-image/multipart-counters';
import { MAX_REQUEST_BODY_SIZE } from './run';

test('serve maxRequestBodySize matches the edits multipart encoded limit', () => {
  expect(MAX_REQUEST_BODY_SIZE).toBe(EDITS_MULTIPART_ENCODED_LIMIT);
  expect(MAX_REQUEST_BODY_SIZE).toBeGreaterThanOrEqual(851_048_559);
});
