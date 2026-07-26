import { expect, test } from 'bun:test';

import { requestMetadata, responseMetadata } from '.';

test('preserves query and ordinary headers while redacting only explicit credentials', () => {
  const request = new Request('https://user:pass@upstream.test/v1/responses?token=query-token&prompt=hello', {
    headers: {
      authorization: 'Bearer secret',
      cookie: 'visible-cookie',
      'x-api-key': 'api-secret',
      'x-long': 'x'.repeat(700),
    },
  });

  expect(requestMetadata(request)).toEqual({
    method: 'GET',
    url: 'https://upstream.test/v1/responses?token=query-token&prompt=hello',
    headers: {
      authorization: '[REDACTED]',
      cookie: 'visible-cookie',
      'x-api-key': '[REDACTED]',
      'x-long': 'x'.repeat(700),
    },
  });
});

test('preserves response headers other than the two explicit credentials', () => {
  const response = new Response(null, {
    status: 202,
    headers: {
      authorization: 'response-auth',
      'set-cookie': 'visible-cookie',
      'x-api-key': 'response-key',
      'x-request-id': 'visible-request-id',
    },
  });

  expect(responseMetadata(response)).toEqual({
    statusCode: 202,
    headers: {
      authorization: '[REDACTED]',
      'set-cookie': 'visible-cookie',
      'x-api-key': '[REDACTED]',
      'x-request-id': 'visible-request-id',
    },
  });
});

test('contains hostile request and response metadata access', () => {
  const unreadable = Object.defineProperties(
    {},
    {
      headers: {
        get: () => {
          throw new Error('unreadable');
        },
      },
      method: {
        get: () => {
          throw new Error('unreadable');
        },
      },
      status: {
        get: () => {
          throw new Error('unreadable');
        },
      },
      url: {
        get: () => {
          throw new Error('unreadable');
        },
      },
    },
  );

  expect(requestMetadata(unreadable as Request)).toEqual({
    method: '[UNREADABLE]',
    url: '[UNREADABLE]',
    headers: {},
  });
  expect(responseMetadata(unreadable as Response)).toEqual({ statusCode: 0, headers: {} });
});
