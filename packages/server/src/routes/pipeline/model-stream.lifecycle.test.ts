import { describe, expect, test } from 'bun:test';

import { openAICompletionsAdapter, openAIResponsesAdapter } from '@aio-proxy/core';

import {
  cancellableTextStream,
  defineProviderRouteSource,
  emptyStream,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  settleRecording,
  textStream,
  textThenErrorStream,
} from '../../../__tests__/pipeline-helpers';
import { handleProtocolRequest } from './index';
import { attemptsOf, pipeline } from './test-support';

describe('shared protocol routing pipeline model stream lifecycle', () => {
  test('treats an empty model stream as pre-commit failure and releases both readers', async () => {
    const primary = modelProvider({ id: 'primary', invoke: emptyStream });
    const backup = modelProvider({ id: 'backup', invoke: () => textStream('backup') });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain('backup');
    await settleRecording(harness.recording);

    expect(primary.calls.model).toHaveLength(1);
    expect(backup.calls.model).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: 502 },
      { outcome: 'success', providerId: 'backup', statusCode: undefined },
    ]);
    expect(harness.usage.capturedStreams.every((stream) => !stream.locked)).toBe(true);
  });

  test('exposes a model stream error after the first event without trying the next candidate', async () => {
    const streamError = new Error('after first event');
    const primary = modelProvider({
      id: 'primary',
      invoke: () => textThenErrorStream('partial', streamError),
    });
    const backup = modelProvider({ id: 'backup', invoke: () => textStream('fallback') });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    await expect(response.text()).rejects.toThrow('after first event');
    await settleRecording(harness.recording);
    expect(primary.calls.model).toHaveLength(1);
    expect(backup.calls.model).toHaveLength(0);
    expect(harness.context.modelInvocationCalls).toBe(1);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: 'primary', outcome: 'failure' }),
    );
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: undefined },
    ]);
    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
  });

  test('releases the preflight reader after a successful stream reaches EOF', async () => {
    const provider = modelProvider({ id: 'provider', invoke: () => textStream('done') });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain('done');
    await settleRecording(harness.recording);

    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: 'provider', outcome: 'success' }),
    );
  });

  test('records the OpenAI Responses ID after the streamed egress completes', async () => {
    const provider = modelProvider({ id: 'provider', invoke: () => textStream('done') });
    const route = defineProviderRouteSource([provider], { outcome: 'success' });
    const response = await handleProtocolRequest({
      adapter: openAIResponsesAdapter,
      context: {},
      rawRequest: jsonRequest({ model: REQUESTED_MODEL, input: 'ping', stream: true }),
      source: route.source,
    });

    const frame = (await response.text())
      .split('\n\n')
      .find((value) => value.startsWith('event: response.completed\n'));
    expect(frame).toBeDefined();
    const completed = JSON.parse(frame?.split('\n')[1]?.slice('data: '.length) ?? 'null') as {
      response: { id: string };
    };
    await settleRecording(route.recording);

    expect(route.recording.finals[0]?.responseId).toBe(completed.response.id);
  });

  test('releases the preflight reader when the client cancels', async () => {
    let cancelCalls = 0;
    const provider = modelProvider({
      id: 'provider',
      invoke: () =>
        cancellableTextStream('partial', () => {
          cancelCalls += 1;
        }),
    });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel('client stopped');
    await settleRecording(harness.recording);

    expect(cancelCalls).toBe(1);
    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: 'provider', outcome: 'failure' }),
    );
  });

  test('cancels the provider model stream through the real protocol egress', async () => {
    let cancelCalls = 0;
    const provider = modelProvider({
      id: 'provider',
      invoke: () =>
        cancellableTextStream('partial', () => {
          cancelCalls += 1;
        }),
    });
    const route = defineProviderRouteSource([provider]);
    const response = await handleProtocolRequest({
      adapter: openAICompletionsAdapter,
      context: {},
      rawRequest: new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: REQUESTED_MODEL, messages: [{ role: 'user', content: 'ping' }], stream: true }),
      }),
      source: route.source,
    });

    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel('client stopped');
    await settleRecording(route.recording);

    expect(cancelCalls).toBe(1);
    expect(route.usage.capturedStreams[0]?.locked).toBe(false);
  });

  test('records stream=true and a numeric ttft for a streamed model attempt', async () => {
    const provider = modelProvider({ id: 'provider', invoke: () => textStream('hello') });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain('hello');
    await settleRecording(harness.recording);

    const attempt = harness.recording.attempts[0];
    expect(attempt?.stream).toBe(true);
    expect(typeof attempt?.ttftMs).toBe('number');
    expect(attempt?.ttftMs).toBeGreaterThanOrEqual(0);
  });

  test('records stream=false and no ttft for a buffered JSON attempt', async () => {
    const provider = modelProvider({ id: 'provider', invoke: () => textStream('hello') });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ output: 'hello' });
    await settleRecording(harness.recording);

    const attempt = harness.recording.attempts[0];
    expect(attempt?.stream).toBe(false);
    expect(attempt?.ttftMs).toBeUndefined();
  });

  test('opens the attempt span before the provider call so buffered requests get real duration', async () => {
    const provider = modelProvider({
      id: 'provider',
      ensureAvailable: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      invoke: () => textStream('hello'),
    });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ output: 'hello' });
    await settleRecording(harness.recording);

    // The span must cover ensureAvailable (~20ms); a zero-width span would mean
    // it was opened only after the provider call returned.
    expect(harness.recording.attempts[0]?.durationMs).toBeGreaterThanOrEqual(10);
  });
});
