import { expect, test } from '@rstest/core';

import { isFailedSpan, isFailedTrace } from './trace-failure';

// 4xx 的 root span 状态按 HTTP 语义约定是 UNSET，只看状态码就会把被拒的请求画成成功。
test('reads a 4xx span as failed even though its OTel status is UNSET', () => {
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.response.status_code': 404 } })).toBe(true);
  expect(isFailedTrace({ otelStatusCode: 'UNSET', finalHttpStatus: 413 })).toBe(true);
});

// 库里现存的 span 全是老 key 写的。少了这条兜底，历史 trace 的 4xx/5xx 会静默变成
// 「没有状态码」，瀑布图在一条失败请求下面画一根绿柱子。
test('still reads a legacy-key 4xx span as failed', () => {
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.status_code': 404 } })).toBe(true);
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.status_code': 200 } })).toBe(false);
});

test('reads a 2xx span as not failed', () => {
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.response.status_code': 200 } })).toBe(false);
  expect(isFailedTrace({ otelStatusCode: 'UNSET', finalHttpStatus: 200 })).toBe(false);
});

test('keeps ERROR failed and a missing status code not failed', () => {
  expect(isFailedSpan({ otelStatusCode: 'ERROR', attributes: {} })).toBe(true);
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: {} })).toBe(false);
  expect(isFailedTrace({ otelStatusCode: 'ERROR', finalHttpStatus: undefined })).toBe(true);
  expect(isFailedTrace({ otelStatusCode: 'UNSET', finalHttpStatus: undefined })).toBe(false);
});

// 属性是任意 JSON，状态码可能是字符串或压根没有；那种时候只能退回状态判断，不能当成失败。
test('ignores a non-numeric status attribute instead of reading it as a failure', () => {
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.response.status_code': '500' } })).toBe(false);
  // 新 key 取不到数就得接着看老 key，而不是把字符串当成「有值」提前收工。
  expect(
    isFailedSpan({
      otelStatusCode: 'UNSET',
      attributes: { 'http.response.status_code': '200', 'http.status_code': 500 },
    }),
  ).toBe(true);
});

// 服务端的 FAILED 显式排除了取消，前端这一处必须跟着 —— 否则取消的链在瀑布图上是红柱子、
// 读屏念「失败」，而列表和分桶图既不算它成功也不算失败。
test('does not call a cancelled trace failed even though its root span is ERROR', () => {
  expect(isFailedSpan({ otelStatusCode: 'ERROR', attributes: {}, terminationReason: 'cancelled' })).toBe(false);
  expect(isFailedTrace({ otelStatusCode: 'ERROR', finalHttpStatus: undefined, terminationReason: 'cancelled' })).toBe(
    false,
  );
  // 原因为空的 ERROR 仍然算失败，别把排除写成「只有 failure 才算」。
  expect(isFailedSpan({ otelStatusCode: 'ERROR', attributes: {}, terminationReason: undefined })).toBe(true);
  // 4xx + 取消也不算失败：取消是一个独立类别，不是失败的子集。
  expect(
    isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.status_code': 499 }, terminationReason: 'cancelled' }),
  ).toBe(false);
});
