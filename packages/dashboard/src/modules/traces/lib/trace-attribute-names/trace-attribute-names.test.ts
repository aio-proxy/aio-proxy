import type { DashboardTraceSpan } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { isAttemptSpan, traceSpanName } from './trace-attribute-names';

const createSpan = (span: Partial<DashboardTraceSpan>): DashboardTraceSpan => ({
  traceId: 'a'.repeat(32),
  spanId: 'c'.repeat(16),
  name: 'aio_proxy.request',
  kind: 'INTERNAL',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:01.000Z',
  durationMs: 1_000,
  otelStatusCode: 'UNSET',
  attributes: {},
  events: [],
  links: [],
  ...span,
});

// 这条存在的唯一理由：把 attempt span 的名字**动态**这件事钉住。
//
// 之前 dashboard 有四处按 `'aio_proxy.provider.attempt'` 这个字面量认 attempt。服务端把
// 生成路径的 span 名改成运行时拼的 `{operation} {model}` 之后，那四处全部失配 —— 逐跳抓包的
// chip 只剩 inbound、attemptCount 恒为 0、归属回退到整条链的最终身份。而 dashboard 的用例
// 全部用写死的旧名造夹具，所以 1105 个测试照样全绿。
//
// 所以这里刻意**不**用固定名：六种能力的动词各来一个，它们都必须被认成 attempt。
test.each([
  'chat claude-sonnet-4-6',
  'embeddings text-embedding-3',
  'image_generation dall-e-3',
  'speech tts-1',
  'transcription whisper-1',
  'video_generation veo-3',
])('recognises the runtime-composed attempt span name %s', (name) => {
  expect(isAttemptSpan(createSpan({ name, kind: 'CLIENT', attributes: { 'aio_proxy.attempt.index': 0 } }))).toBe(true);
});

test('token-count attempts keep the fixed name and still count as attempts', () => {
  const span = createSpan({ name: traceSpanName.attempt, attributes: { 'aio_proxy.attempt.index': 0 } });

  expect(isAttemptSpan(span)).toBe(true);
});

// 略过的候选是唯一「带 index 但不是一次尝试」的形状，靠名字排掉。少了这条，token-count 的
// 逐跳列表会把没打过的候选也画成一跳。
test('a skipped token-count candidate carries an index but is not an attempt', () => {
  const span = createSpan({ name: traceSpanName.candidateSkipped, attributes: { 'aio_proxy.attempt.index': 0 } });

  expect(isAttemptSpan(span)).toBe(false);
});

test.each([traceSpanName.inference, 'aio_proxy.request', 'aio_proxy.request.parse', 'POST'])(
  'treats %s as not an attempt because it carries no attempt index',
  (name) => {
    expect(isAttemptSpan(createSpan({ name }))).toBe(false);
  },
);
