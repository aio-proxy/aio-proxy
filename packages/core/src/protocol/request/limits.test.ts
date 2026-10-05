import { expect, test } from 'bun:test';

import * as request from './index';

const json64 = JSON.stringify({ padding: 'x'.repeat(50) });
const plainRequest = () => new Request('https://proxy.test/v1/responses', { method: 'POST', body: json64 });

test('isolates interleaved async request budgets', async () => {
  expect(request.withRequestBodyLimits).toBeFunction();
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const small = request.withRequestBodyLimits({ encoded: 32, decoded: 32 }, async () => {
    await ready;
    return request.readJsonRequest(plainRequest());
  });
  const large = request.withRequestBodyLimits({ encoded: 128, decoded: 128 }, async () => {
    release();
    await Promise.resolve();
    return request.readJsonRequest(plainRequest());
  });
  const results = await Promise.allSettled([small, large]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
  expect(results[0]).toMatchObject({ reason: expect.any(request.RequestBodyTooLargeError) });
  expect(results[1]).toMatchObject({ value: { padding: 'x'.repeat(50) } });
});

test('explicit budgets override scoped defaults', async () => {
  expect(request.withRequestBodyLimits).toBeFunction();
  await request.withRequestBodyLimits({ encoded: 32, decoded: 32 }, async () => {
    expect(await request.readJsonRequest(plainRequest(), { encoded: 128, decoded: 128 })).toEqual({
      padding: 'x'.repeat(50),
    });
  });
});

test('copies and freezes budgets and restores nested scopes after rejection', async () => {
  expect(request.withRequestBodyLimits).toBeFunction();
  expect(request.currentRequestBodyLimits).toBeFunction();
  const limits = { encoded: 128, decoded: 128 };
  await request.withRequestBodyLimits(limits, async () => {
    limits.encoded = 1;
    expect(Object.isFrozen(request.currentRequestBodyLimits())).toBe(true);
    expect(await request.readJsonRequest(plainRequest())).toEqual({ padding: 'x'.repeat(50) });
    await expect(
      request.withRequestBodyLimits({ encoded: 32, decoded: 32 }, async () => {
        await Promise.resolve();
        return request.readJsonRequest(plainRequest());
      }),
    ).rejects.toBeInstanceOf(request.RequestBodyTooLargeError);
    expect(request.currentRequestBodyLimits()).toEqual({ encoded: 128, decoded: 128 });
  });
  expect(request.currentRequestBodyLimits()).toEqual({ encoded: 268435456, decoded: 268435456 });
});

test('plain JSON respects the decoded budget even when encoded bytes fit', async () => {
  await expect(request.readJsonRequest(plainRequest(), { encoded: 128, decoded: 32 })).rejects.toBeInstanceOf(
    request.RequestBodyTooLargeError,
  );
});

test('plain decoded streams enforce both budgets', async () => {
  const stream = await request.decodedRequestStream(plainRequest(), { encoded: 128, decoded: 32 });
  await expect(new Response(stream).text()).rejects.toBeInstanceOf(request.RequestBodyTooLargeError);
});

test('decoded streams retain their creation budget when consumed outside the scope', async () => {
  expect(request.withRequestBodyLimits).toBeFunction();
  const stream = await request.withRequestBodyLimits({ encoded: 128, decoded: 32 }, () => {
    const raw = new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-encoding': 'gzip' },
      body: Bun.gzipSync(new TextEncoder().encode(json64)),
    });
    return request.decodedRequestStream(raw);
  });
  await expect(new Response(stream).text()).rejects.toBeInstanceOf(request.RequestBodyTooLargeError);
});

test('model rewriting uses the request scope budget', async () => {
  expect(request.withRequestBodyLimits).toBeFunction();
  await expect(
    request.withRequestBodyLimits({ encoded: 32, decoded: 32 }, () =>
      request.rewriteJsonRequestModel(plainRequest(), 'upstream'),
    ),
  ).rejects.toBeInstanceOf(request.RequestBodyTooLargeError);
});
