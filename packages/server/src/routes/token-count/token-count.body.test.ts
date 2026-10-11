import { expect, spyOn, test } from 'bun:test';

import { anthropicMessagesAdapter, REQUEST_BODY_LIMITS, Router } from '@aio-proxy/core';
import type { TokenCountCapability } from '@aio-proxy/plugin-sdk';
import { ConfigSchema, type Config, ProviderKind } from '@aio-proxy/types';

import { createRecording } from '../../../__tests__/pipeline-helpers/recording';
import { LogicalSessionStore } from '../../logical-session-store';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../runtime';
import { handleTokenCount } from './token-count';

test('rejects oversized Content-Length and cancels the count request body before parsing', async () => {
  let cancelled = false;
  const request = new Request('https://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-length': String(REQUEST_BODY_LIMITS.encoded + 1), 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  });
  const fixture = countFixture([]);

  const response = await runCount(fixture.source, request);

  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(request.bodyUsed).toBe(true);
  expect(fixture.recording.begins).toHaveLength(1);
  expect(fixture.recording.finals).toEqual([
    expect.objectContaining({ outcome: 'failure', finalStatusCode: 413, errorCode: 'request_too_large' }),
  ]);
  expect(fixture.releases()).toBe(0);
});

test('rejects unsupported content encoding before counting tokens', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const fixture = countFixture([]);
  try {
    const response = await runCount(
      fixture.source,
      new Request('https://proxy.test/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'content-encoding': 'compress', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'count-model', max_tokens: 16, messages: [] }),
      }),
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Unsupported Content-Encoding' },
    });
    expect(fixture.recording.begins).toHaveLength(1);
    expect(fixture.recording.finals).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        finalStatusCode: 415,
        errorCode: 'unsupported_content_encoding',
      }),
    ]);
    expect(fixture.releases()).toBe(0);
  } finally {
    warn.mockRestore();
  }
});

test('releases the retained count body after a provider returns a real count', async () => {
  const request = anthropicRequest();
  const fixture = countFixture([
    countProvider(async ({ request: replay }) => {
      expect(await replay.json()).toEqual({
        max_tokens: 16,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'count-model',
      });
      return { inputTokens: 5 };
    }),
  ]);

  const response = await runCount(fixture.source, request);

  expect(await response.json()).toEqual({ input_tokens: 5 });
  expect(request.bodyUsed).toBe(true);
});

test('releases the retained count body after returning an estimate', async () => {
  const request = anthropicRequest();
  const fixture = countFixture([
    countProvider(async () => {
      throw new Error('counter unavailable');
    }),
  ]);

  const response = await runCount(fixture.source, request);

  // Every counter failed, so the route returns a local estimate (a non-negative integer).
  expect(response.status).toBe(200);
  const body = (await response.json()) as { input_tokens: number };
  expect(Number.isInteger(body.input_tokens)).toBe(true);
  expect(request.bodyUsed).toBe(true);
});

test.each([false, true])('uses the configured budget for %s token-count bodies', async (compressed) => {
  const config = ConfigSchema.parse({ server: { requestBody: { maxBytes: 1_048_576 } }, providers: {} });
  let calls = 0;
  const fixture = countFixture(
    [
      countProvider(async () => {
        calls += 1;
        return { inputTokens: 5 };
      }),
    ],
    config,
  );
  const text = JSON.stringify({
    model: 'count-model',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'x'.repeat(1_048_576) }],
  });
  const response = await runCount(
    fixture.source,
    new Request('https://proxy.test/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(compressed ? { 'content-encoding': 'gzip' } : {}) },
      body: compressed ? Bun.gzipSync(Buffer.from(text)) : text,
    }),
  );
  expect(response.status).toBe(413);
  expect(calls).toBe(0);
});

function countFixture(providers: readonly RuntimeProviderInstance[], config?: Config) {
  const router = new Router(providers);
  const recording = createRecording();
  let releaseCount = 0;
  const source = {
    acquireProviderSnapshot: () => ({
      snapshot: { providers, router, ...(config === undefined ? {} : { config }) },
      release: () => {
        releaseCount += 1;
      },
    }),
    currentProviderSnapshot: () => ({ providers, router, ...(config === undefined ? {} : { config }) }),
    logger() {},
    logicalSessionStore: new LogicalSessionStore(),
    requestRecorder: recording.recorder,
    usageCapture: {
      passthrough(): never {
        throw new Error('token counting must not capture generation usage');
      },
      stream(): never {
        throw new Error('token counting must not capture generation usage');
      },
    },
  } satisfies ProviderRouteSource;
  return { recording, releases: () => releaseCount, source };
}

function countProvider(countTokens: TokenCountCapability['countTokens']): RuntimeProviderInstance {
  return {
    alias: { 'count-model': { model: 'count-wire', preserve: false } },
    capabilityIndex: { 'count-wire': new Set(['language']) },
    enabled: true,
    id: 'counter',
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

function runCount(source: ProviderRouteSource, rawRequest: Request): Promise<Response> {
  return handleTokenCount({
    adapter: anthropicMessagesAdapter,
    context: {},
    format: (inputTokens) => ({ input_tokens: inputTokens }),
    rawRequest,
    source,
  });
}

function anthropicRequest(): Request {
  return new Request('https://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'count-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
}

test('token-count preflight honors the configured declared-size limit', async () => {
  const config = ConfigSchema.parse({ server: { requestBody: { maxBytes: 1_048_576 } }, providers: {} });
  const fixture = countFixture([], config);
  const raw = anthropicRequest();
  raw.headers.set('content-length', '1048577');
  expect((await runCount(fixture.source, raw)).status).toBe(413);
  expect(fixture.releases()).toBe(0);
});
