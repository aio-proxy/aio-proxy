import { expect, test } from 'bun:test';

import { anthropicMessagesAdapter } from '@aio-proxy/core';
import type { TokenCountCapability } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';

import type { ProviderRouteSource, RuntimeProviderInstance } from '../../runtime';
import { handleTokenCount } from './token-count';
import { countFixture } from './token-count.test-support';

test('releases the retained body when count request validation fails', async () => {
  const request = new Request('https://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'count-model', max_tokens: 16, messages: 'invalid' }),
  });
  const fixture = countFixture([]);

  const response = await runCount(fixture.source, request);

  expect(response.status).toBe(400);
  expect(request.bodyUsed).toBe(true);
  expect(fixture.recording.begins).toEqual([{ inboundProtocol: anthropicMessagesAdapter.protocol }]);
  expect(fixture.recording.finals).toEqual([
    expect.objectContaining({ outcome: 'failure', finalStatusCode: 400, errorCode: 'invalid_request' }),
  ]);
  expect(fixture.releases()).toBe(0);
});

test('finishes the trace before rethrowing an unmapped request error', async () => {
  const failure = new Error('unexpected parse failure');
  const request = anthropicRequest(new AbortController().signal);
  const fixture = countFixture([]);
  const adapter = {
    ...anthropicMessagesAdapter,
    parse: () => Promise.reject(failure),
  };

  await expect(runCount(fixture.source, request, { adapter })).rejects.toBe(failure);

  expect(request.bodyUsed).toBe(true);
  expect(fixture.recording.attempts).toEqual([]);
  expect(fixture.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
  expect(fixture.releases()).toBe(0);
});

test('does not mask an unrelated request error when the signal is already aborted', async () => {
  const controller = new AbortController();
  const abortReason = new DOMException('client cancelled', 'AbortError');
  const failure = new Error('unexpected parse failure');
  const request = anthropicRequest(controller.signal);
  controller.abort(abortReason);
  const fixture = countFixture([]);
  const adapter = {
    ...anthropicMessagesAdapter,
    parse: () => Promise.reject(failure),
  };

  await expect(runCount(fixture.source, request, { adapter })).rejects.toBe(failure);

  expect(request.bodyUsed).toBe(true);
  expect(fixture.recording.attempts).toEqual([]);
  expect(fixture.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
  expect(fixture.releases()).toBe(0);
});

const responseFormattingCases = [
  ['count', countProvider(async () => ({ inputTokens: 5 })), { outcome: 'success', statusCode: 200 }],
  [
    'estimated count',
    countProvider(() => Promise.reject(new Error('counter unavailable'))),
    { outcome: 'failure', statusCode: 500 },
  ],
] as const;

test.each(responseFormattingCases)(
  'builds the %s response before recording success',
  async (_name, provider, attempt) => {
    const failure = new Error('response formatting failed');
    const request = anthropicRequest(new AbortController().signal);
    const fixture = countFixture([provider]);
    await expect(
      runCount(fixture.source, request, {
        format: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(request.bodyUsed).toBe(true);
    expect(fixture.recording.attempts).toEqual([expect.objectContaining({ ...attempt, providerId: 'counter' })]);
    expect(fixture.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
    expect(fixture.releases()).toBe(1);
  },
);

test('rethrows an unmapped provider error instead of returning an estimate', async () => {
  const failure = Object.freeze({ kind: 'unexpected-provider-failure' });
  const request = anthropicRequest(new AbortController().signal);
  const fixture = countFixture([countProvider(() => Promise.reject(failure))]);

  await expect(runCount(fixture.source, request)).rejects.toBe(failure);

  expect(request.bodyUsed).toBe(true);
  expect(fixture.recording.attempts).toEqual([expect.objectContaining({ outcome: 'failure', providerId: 'counter' })]);
  expect(fixture.recording.attempts[0]).not.toHaveProperty('statusCode');
  expect(fixture.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
  expect(fixture.releases()).toBe(1);
});

const abortReasons = [
  ['Error', new Error('client cancelled')],
  ['DOMException', new DOMException('client cancelled', 'AbortError')],
  ['non-Error', { code: 'client_cancelled' }],
] as const;

test.each(abortReasons)(
  'preserves an exact %s reason without calling a counter when pre-aborted',
  async (_type, reason) => {
    const controller = new AbortController();
    const request = anthropicRequest(controller.signal);
    controller.abort(reason);
    let calls = 0;
    const fixture = countFixture([
      countProvider(async () => {
        calls += 1;
        return { inputTokens: 5 };
      }),
    ]);

    const result = await settleWithin(runCount(fixture.source, request), 100);

    expect(result).toBe(reason);
    expect(calls).toBe(0);
    expect(fixture.recording.attempts).toEqual([]);
    expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
    expect(fixture.releases()).toBe(1);
  },
);

test('does not return success when the request aborts while a counter ignores its signal', async () => {
  const controller = new AbortController();
  const reason = new Error('client cancelled during count');
  const started = deferred<void>();
  const release = deferred<void>();
  const fixture = countFixture([
    countProvider(async () => {
      started.resolve(undefined);
      await release.promise;
      return { inputTokens: 5 };
    }),
  ]);

  const response = runCount(fixture.source, anthropicRequest(controller.signal));
  await started.promise;
  controller.abort(reason);
  release.resolve(undefined);
  const result = await settleWithin(response, 100);

  expect(result).toBe(reason);
  expect(fixture.recording.attempts).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
  expect(fixture.recording.attempts[0]).not.toHaveProperty('statusCode');
  expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
  expect(fixture.recording.finals[0]).not.toHaveProperty('finalStatusCode');
  expect(fixture.releases()).toBe(1);
});

test('does not mask an unrelated counter error when the signal aborts', async () => {
  const controller = new AbortController();
  const abortReason = new Error('client cancelled first count');
  const counterError = new Error('first counter failed after abort');
  let secondCalls = 0;
  const fixture = countFixture([
    countProvider(async () => {
      controller.abort(abortReason);
      throw counterError;
    }, 'first'),
    countProvider(async () => {
      secondCalls += 1;
      return { inputTokens: 9 };
    }, 'second'),
  ]);

  await expect(runCount(fixture.source, anthropicRequest(controller.signal))).rejects.toBe(counterError);

  expect(secondCalls).toBe(0);
  expect(fixture.recording.attempts).toEqual([
    expect.objectContaining({ modelId: 'first-wire', outcome: 'failure', providerId: 'first' }),
  ]);
  expect(fixture.recording.attempts[0]).not.toHaveProperty('statusCode');
  expect(fixture.recording.finals).toEqual([{ outcome: 'failure', errorCode: 'internal_error' }]);
  expect(fixture.recording.finals[0]).not.toHaveProperty('finalStatusCode');
  expect(fixture.releases()).toBe(1);
});

test.each(abortReasons)('maps no fake provider error for an exact %s abort reason', async (_type, reason) => {
  const controller = new AbortController();
  const started = deferred<void>();
  const release = deferred<void>();
  const fixture = countFixture([
    countProvider(async () => {
      started.resolve(undefined);
      await release.promise;
      throw reason;
    }),
  ]);

  const response = runCount(fixture.source, anthropicRequest(controller.signal));
  await started.promise;
  controller.abort(reason);
  release.resolve(undefined);
  const result = await settleWithin(response, 100);

  expect(result).toBe(reason);
  expect(fixture.recording.attempts).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
  expect(fixture.recording.attempts[0]).not.toHaveProperty('statusCode');
  expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
  expect(fixture.recording.finals[0]).not.toHaveProperty('finalStatusCode');
  expect(fixture.releases()).toBe(1);
});

function countProvider(countTokens: TokenCountCapability['countTokens'], id = 'counter'): RuntimeProviderInstance {
  return {
    alias: { 'count-model': { model: `${id}-wire`, preserve: false } },
    capabilityIndex: { [`${id}-wire`]: new Set(['language']) },
    enabled: true,
    id,
    kind: ProviderKind.OAuth,
    model: {
      invoke() {
        throw new Error('generation must not run during token counting');
      },
      supportsProviderTool: () => true,
    },
    tokenCount: { countTokens },
  };
}

function runCount(
  source: ProviderRouteSource,
  rawRequest: Request,
  options: {
    readonly adapter?: typeof anthropicMessagesAdapter;
    readonly format?: (inputTokens: number) => unknown;
  } = {},
): Promise<Response> {
  return handleTokenCount({
    adapter: options.adapter ?? anthropicMessagesAdapter,
    context: {},
    format: options.format ?? ((inputTokens) => ({ input_tokens: inputTokens })),
    rawRequest,
    source,
  });
}

function anthropicRequest(signal: AbortSignal): Request {
  return new Request('https://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'count-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    }),
    signal,
  });
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class TimeoutError extends Error {}
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch((error: unknown) => error),
      new Promise<TimeoutError>((resolve) => {
        timeout = setTimeout(() => resolve(new TimeoutError('Timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
