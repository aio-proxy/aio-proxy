/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';

import { createAttemptResponseObservation, currentAttemptResponseObservation, withAttemptResponseObservation } from '.';

test('records one controlled SSE response against the candidate baseline', () => {
  let now = 1_000;
  const observation = createAttemptResponseObservation({ startedAt: 1_000, now: () => now });
  observation.markTransportUnavailable();
  observation.observeFetchStart();
  now = 1_012;
  const body = observation.observeResponse(
    new Response('data: {}\n\n', {
      headers: { 'content-type': 'text/event-stream', 'content-encoding': 'identity' },
    }),
    { controlledStream: true },
  );
  now = 1_018;
  body?.observeRead(10, 2);
  now = 1_021;
  observation.observeSseEvent();
  now = 1_030;
  observation.observeContent();
  now = 1_041;
  observation.observeContent();

  expect(observation.snapshot()).toEqual({
    transportObservation: 'sse',
    upstreamHeadersMs: 12,
    firstUpstreamByteMs: 18,
    firstSseEventMs: 21,
    contentGapP95Ms: 11,
    maxSseFramesPerRead: 2,
    contentEncoding: 'identity',
  });
});

test('omits unobserved values instead of writing zero', () => {
  const observation = createAttemptResponseObservation({ startedAt: 5, now: () => 5 });
  expect(observation.snapshot()).toEqual({});
  observation.markTransportUnavailable();
  expect(observation.snapshot()).toEqual({ transportObservation: 'unavailable' });
  observation.observeFetchStart();
  expect(observation.snapshot()).toEqual({});
});

test('keeps meaningful zero timings and ignores empty reads', () => {
  const observation = createAttemptResponseObservation({ startedAt: 5, now: () => 5 });
  observation.observeFetchStart();
  const body = observation.observeResponse(new Response('', { headers: { 'content-type': 'text/event-stream' } }), {
    controlledStream: true,
  });
  body?.observeRead(0, 0);
  expect(observation.snapshot()).toEqual({
    transportObservation: 'sse',
    upstreamHeadersMs: 0,
    contentEncoding: 'identity',
  });

  body?.observeRead(1, 0);
  observation.observeSseEvent();
  observation.observeContent();
  observation.observeContent();
  expect(observation.snapshot()).toEqual({
    transportObservation: 'sse',
    upstreamHeadersMs: 0,
    firstUpstreamByteMs: 0,
    firstSseEventMs: 0,
    contentGapP95Ms: 0,
    contentEncoding: 'identity',
  });
});

test('keeps semantic gaps but removes raw metrics after two responses', () => {
  let now = 0;
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => now });
  observation.observeFetchStart();
  observation.observeResponse(new Response('one'), { controlledStream: false });
  observation.observeFetchStart();
  observation.observeResponse(new Response('two'), { controlledStream: false });
  observation.observeContent(10);
  observation.observeContent(20);
  expect(observation.snapshot()).toEqual({ transportObservation: 'ambiguous', contentGapP95Ms: 10 });
});

test('records headers but omits controlled-body metrics for a platform-managed response', () => {
  const observation = createAttemptResponseObservation({ startedAt: 10, now: () => 10 });
  observation.observeFetchStart();
  expect(observation.observeResponse(new Response('body'), { controlledStream: false })).toBeUndefined();
  expect(observation.snapshot()).toEqual({ transportObservation: 'body', upstreamHeadersMs: 0 });
});

describe('content encoding', () => {
  test.each([
    [undefined, 'identity'],
    ['identity', 'identity'],
    ['GZip', 'gzip'],
    ['deflate', 'deflate'],
    ['br', 'br'],
    ['zstd', 'zstd'],
    ['gzip, br', 'multiple'],
    ['compress', 'other'],
  ] as const)('normalizes %s to %s', (header, expected) => {
    const headers = new Headers({ 'content-type': 'text/event-stream' });
    if (header !== undefined) headers.set('content-encoding', header);
    const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
    observation.observeFetchStart();
    observation.observeResponse(new Response('', { headers }), { controlledStream: true });
    expect(observation.snapshot().contentEncoding).toBe(expected);
  });
});

test.each([
  [0, 0],
  [250, 250],
  [250.1, 260],
  [260, 260],
  [1_000, 1_000],
  [1_000.1, 1_100],
  [10_000, 10_000],
  [10_000.1, 11_000],
  [60_000, 60_000],
  [60_000.1, 60_000],
] as const)('places a %dms gap in the %dms upper-bound bucket', (gap, expected) => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
  observation.observeContent(0);
  observation.observeContent(gap);
  expect(observation.snapshot().contentGapP95Ms).toBe(expected);
});

test('uses nearest-rank p95', () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
  let at = 0;
  observation.observeContent(at);
  for (let gap = 1; gap <= 20; gap++) observation.observeContent((at += gap));
  expect(observation.snapshot().contentGapP95Ms).toBe(19);
});

test('uses nearest-rank p95 and the rounded actual maximum in overflow', () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
  observation.observeContent(0);
  for (const at of [1, 2, 3, 4, 61_238.4, 123_584]) observation.observeContent(at);
  expect(observation.snapshot().contentGapP95Ms).toBe(62_346);
});

test('scopes the current observation to the operation', async () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 0 });
  expect(currentAttemptResponseObservation()).toBeUndefined();
  await withAttemptResponseObservation(observation, async () => {
    await Promise.resolve();
    expect(currentAttemptResponseObservation()).toBe(observation);
  });
  expect(currentAttemptResponseObservation()).toBeUndefined();
});
