import { expect, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import { ConfigSchema } from '@aio-proxy/types';

import { rawProvider } from '../../../__tests__/pipeline-helpers';
import { attributeName } from '../../request-tracing';
import { handleProtocolRequest } from './index';
import { inspectRequestContentLength } from './request';
import { pipeline } from './test-support';

test('preflight uses adapter bodyLimits encoded, not the language 64 MiB constant', () => {
  const raw = new Request('https://x', {
    method: 'POST',
    headers: { 'content-length': String(65 * 1_024 * 1_024) },
    body: 'x',
  });
  expect(inspectRequestContentLength(raw, { encoded: 357_564_416, decoded: 357_564_416 })).toBeUndefined();
  expect(inspectRequestContentLength(raw, { encoded: 64 * 1_024 * 1_024, decoded: 128 * 1_024 * 1_024 })).toEqual(
    expect.objectContaining({ kind: 'too_large' }),
  );
});

test('an aborted upload settles its trace as cancelled', async () => {
  const controller = new AbortController();
  const provider = rawProvider({ id: 'raw' });
  const harness = pipeline([provider], { adapter: openAIResponsesAdapter });
  const request = new Request('https://proxy.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: controller.signal,
    body: new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"model":'));
      },
    }),
  });

  const pending = harness.run(request);
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(DOMException);

  const root = harness.recording.spans.find((span) => span.parentSpanId == null);
  expect(root?.attributes[attributeName.terminationReason]).toBe('cancelled');
  expect(provider.calls.raw).toHaveLength(0);
});

test.each(['private-input', '-1', '1.5', 'Infinity'])(
  'rejects invalid Content-Length %s as 400 without logging the value',
  async (length) => {
    const provider = rawProvider({ id: 'raw' });
    const harness = pipeline([provider]);
    const response = await harness.run(
      new Request('https://proxy.test/v1/test', { method: 'POST', headers: { 'content-length': length }, body: '{}' }),
    );
    expect(response.status).toBe(400);
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: 'request.rejected',
        errorCode: 'invalid_request',
        bodyRejectReason: 'invalid_content_length',
        bodyContentEncoding: 'identity',
      }),
    );
    if (length === 'private-input') expect(JSON.stringify(harness.logs)).not.toContain(length);
    const root = harness.recording.spans.find((span) => span.parentSpanId == null);
    expect(root?.attributes[attributeName.bodyRejectReason]).toBe('invalid_content_length');
  },
);

test.each(['declared', 'chunked', 'gzip', 'zstd'] as const)(
  'keeps %s body rejection diagnostics in sensitive logs and root spans',
  async (mode) => {
    const provider = rawProvider({ id: 'raw' });
    const text = JSON.stringify({ model: 'test-model', input: 'private-input'.repeat(100_000) });
    const plain = Buffer.from(text);
    const bytes = mode === 'gzip' ? Bun.gzipSync(plain) : mode === 'zstd' ? Bun.zstdCompressSync(plain) : plain;
    const limit = 1_048_576;
    const adapter = openAIResponsesAdapter;
    const harness = pipeline([provider], {
      adapter,
      config: ConfigSchema.parse({ server: { requestBody: { maxBytes: limit } }, providers: {} }),
    });
    const raw = new Request('https://proxy.test/v1/responses?private-input', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'private-input',
        'x-private': 'private-input',
        ...(mode === 'declared' ? { 'content-length': String(bytes.byteLength) } : {}),
        ...(mode === 'gzip' || mode === 'zstd' ? { 'content-encoding': mode } : {}),
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    const source = { ...harness.source, preObservationCapturePolicy: async () => ({ capturePayload: false }) };
    const response = await handleProtocolRequest({ adapter, context: {}, rawRequest: raw, source });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('request_too_large');
    const rejected = harness.logs.find((entry) => entry.event === 'request.rejected')!;
    const decoded = mode === 'gzip' || mode === 'zstd';
    expect(rejected.bodyLimitStage).toBe(decoded ? 'decoded' : 'encoded');
    expect(rejected.bodyLimitBytes).toBe(limit);
    expect(rejected.bodyMeasurement).toBe(
      decoded ? 'unknown' : mode === 'declared' ? 'declared' : 'observed_lower_bound',
    );
    if (decoded) expect(rejected.bodyBytes).toBeUndefined();
    else expect(rejected.bodyBytes).toBeGreaterThan(rejected.bodyLimitBytes as number);
    expect(rejected.bodyContentEncoding).toBe(decoded ? mode : 'identity');
    const root = harness.recording.spans.find((span) => span.parentSpanId == null)!;
    for (const field of [
      'bodyLimitStage',
      'bodyLimitBytes',
      'bodyMeasurement',
      'bodyBytes',
      'bodyContentEncoding',
    ] as const) {
      expect(root.attributes[attributeName[field]]).toEqual(rejected[field]);
    }
    expect(JSON.stringify({ logs: harness.logs, spans: harness.recording.spans })).not.toContain('private-input');
    expect(provider.calls.raw).toHaveLength(0);
  },
);
