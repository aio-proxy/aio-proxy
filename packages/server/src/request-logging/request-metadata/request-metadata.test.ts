import { expect, test } from 'bun:test';

import { redactCredentialHeaders, redactUrlCredentials, requestMetadata, responseMetadata } from '.';

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

// camelCase 的参数名曾经整条漏过去：只按非字母数字切词的话 `accessToken` 小写成
// `accesstoken` 是一个整词，单词表里没有，凭据就明文落盘并经抓包接口送进浏览器。
// 这些名字都是真实上游用过的形态，不是臆造的。
test.each([
  'accessToken',
  'authToken',
  'clientSecret',
  'refreshToken',
  'apiKey',
  'APIKey',
  'sessionCredential',
  'xGoogApiKey',
])('redacts the camelCase credential parameter %s', (name) => {
  const metadata = requestMetadata(new Request(`https://upstream.test/v1?${name}=real-secret&prompt=hi`));

  expect(metadata.url).not.toContain('real-secret');
  expect(metadata.url).toContain('prompt=hi');
});

// 按词匹配的代价是可能误伤，所以反面也要钉住：这些名字含凭据词的**子串**但不是凭据。
test.each(['keyword', 'monkey', 'tokenizer', 'authority', 'signal'])(
  'keeps the ordinary parameter %s readable',
  (name) => {
    const metadata = requestMetadata(new Request(`https://upstream.test/v1?${name}=plain-value`));

    expect(metadata.url).toContain('plain-value');
  },
);

// 读侧走的是同一个 isCredentialParam，但抓包接口读的是磁盘上**已经落盘**的旧行 —— 那些行是
// camelCase 漏脱之前写的，明文就在里面。所以读侧这条断言不是重复，它保护的是历史数据。
test('redacts camelCase credentials again when replaying an already-persisted URL', () => {
  const persisted = 'https://upstream.test/v1?accessToken=leaked-secret&clientSecret=also-leaked&prompt=hi';

  const replayed = redactUrlCredentials(persisted);

  expect(replayed).not.toContain('leaked-secret');
  expect(replayed).not.toContain('also-leaked');
  expect(replayed).toContain('prompt=hi');
});

test('leaves a URL it cannot parse alone instead of throwing', () => {
  expect(redactUrlCredentials('not a url')).toBe('not a url');
  expect(redactCredentialHeaders({ authorization: 'Bearer x', accept: 'application/json' })).toEqual({
    authorization: '[REDACTED]',
    accept: 'application/json',
  });
});

// provider 配置允许写任意 header，api.ts 会把它们逐条 set 到上游请求上。固定名单认不出
// `X-Secret` 这种自定义认证头，于是凭据明文落盘并经抓包接口送进浏览器。
test.each(['X-Secret', 'X-Auth-Token', 'X-Access-Token', 'My-Api-Key', 'X-Client-Secret', 'X-Signature'])(
  'redacts the custom credential header %s',
  (name) => {
    const metadata = requestMetadata(new Request('https://upstream.test/v1', { headers: { [name]: 'real-secret' } }));

    expect(Object.values(metadata.headers)).not.toContain('real-secret');
    // 读侧走同一个判定，旧日志重放时也要脱。
    expect(Object.values(redactCredentialHeaders({ [name]: 'real-secret' }))).not.toContain('real-secret');
  },
);

// 按词匹配的代价是误伤，头这边同样要钉反面：这些是常见的普通头，脱了它们等于把调试信息
// 白白打码。`authority` 尤其重要 —— HTTP/2 的 :authority 伪头长这样。
test.each(['content-type', 'x-request-id', 'user-agent', 'accept-encoding', 'x-authority', 'x-api-version'])(
  'keeps the ordinary header %s readable',
  (name) => {
    const metadata = requestMetadata(new Request('https://upstream.test/v1', { headers: { [name]: 'plain-value' } }));

    expect(Object.values(metadata.headers)).toContain('plain-value');
  },
);
