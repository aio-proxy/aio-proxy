import { expect, test } from 'bun:test';

import { requestMetadata, responseMetadata } from '.';

// query 里的凭据和 header 里的一样要脱：不少上游走 URL 认证，而抓包接口把记下的 URL
// 原样送进浏览器。按词匹配，所以 `prompt` 这种普通参数留着，`keyword` 也不会被误伤。
test('redacts credentials in the url and the headers, keeping ordinary query and headers', () => {
  const request = new Request(
    'https://user:pass@upstream.test/v1/responses?token=query-secret&keyword=hi&prompt=hello',
    {
      headers: {
        authorization: 'Bearer secret',
        cookie: 'session=secret',
        'x-api-key': 'api-secret',
        'x-goog-api-key': 'google-secret',
        'x-long': 'x'.repeat(700),
      },
    },
  );

  expect(requestMetadata(request)).toEqual({
    method: 'GET',
    url: 'https://upstream.test/v1/responses?token=%5BREDACTED%5D&keyword=hi&prompt=hello',
    headers: {
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-goog-api-key': '[REDACTED]',
      'x-long': 'x'.repeat(700),
    },
  });
});

test('redacts credentials on the response side too, keeping ordinary headers', () => {
  const response = new Response(null, {
    status: 202,
    headers: {
      authorization: 'response-auth',
      'set-cookie': 'session=secret',
      'x-api-key': 'response-key',
      'x-request-id': 'visible-request-id',
    },
  });

  expect(responseMetadata(response)).toEqual({
    statusCode: 202,
    headers: {
      authorization: '[REDACTED]',
      'set-cookie': '[REDACTED]',
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
