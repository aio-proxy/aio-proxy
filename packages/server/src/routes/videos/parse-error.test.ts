import { expect, test } from 'bun:test';

import { OpenAIVideosInvalidRequestError } from '@aio-proxy/core';

import { videosParseErrorResponse } from './parse-error';

test('malformed and invalid Videos input stay client errors', () => {
  expect(videosParseErrorResponse(new SyntaxError('bad json'))?.status).toBe(400);
  expect(videosParseErrorResponse(new OpenAIVideosInvalidRequestError('prompt'))?.status).toBe(400);
});

test('an operational spool failure is not a client 400', () => {
  const error = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  expect(videosParseErrorResponse(error)).toBeUndefined();
});
