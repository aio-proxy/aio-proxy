import { expect, test } from '@rstest/core';

import { isFailedSpan, isFailedTrace } from './trace-failure';

// 4xx 的 root span 状态按 HTTP 语义约定是 UNSET，只看状态码就会把被拒的请求画成成功。
test('reads a 4xx span as failed even though its OTel status is UNSET', () => {
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.status_code': 404 } })).toBe(true);
  expect(isFailedTrace({ otelStatusCode: 'UNSET', finalHttpStatus: 413 })).toBe(true);
});

test('reads a 2xx span as not failed', () => {
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.status_code': 200 } })).toBe(false);
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
  expect(isFailedSpan({ otelStatusCode: 'UNSET', attributes: { 'http.status_code': '500' } })).toBe(false);
});
