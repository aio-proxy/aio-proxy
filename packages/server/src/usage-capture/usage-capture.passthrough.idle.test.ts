import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

describe('passthrough idle timeout', () => {
  test('stalled stream resolves failure with stream_idle_timeout and cancels upstream', async () => {
    let cancelled = false;
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
          ),
        );
      },
      pull() {
        return new Promise<void>(() => {}); // never resolves — simulates a hung-open upstream
      },
      cancel() {
        cancelled = true;
      },
    });
    const captured = createUsageCapture().passthrough({
      response: new Response(stalling, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
      idleTimeoutMs: 40,
    });

    // consume the first delivered chunk, then keep reading — upstream hangs until
    // the idle timer cancels it, which must surface to the client as a stream
    // error (not a clean EOF that masks the truncated response).
    const reader = captured.value.body!.getReader();
    await reader.read();

    await expect(reader.read()).rejects.toThrow('stream_idle_timeout');
    await expect(captured.completion).resolves.toEqual({
      outcome: 'failure',
      statusCode: 200,
      errorCode: 'stream_idle_timeout',
    });
    expect(cancelled).toBe(true);
  });

  test('a slow client that stops reading does not trigger an upstream idle timeout', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    // Upstream has a second chunk ready immediately — it is never idle.
    const ready = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"a"}\n\n'));
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"delta":"b"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const captured = createUsageCapture().passthrough({
      response: new Response(ready, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
      idleTimeoutMs: 40,
    });

    // Read the first chunk, then stop reading for well past the idle window. The
    // timeout measures upstream stalls, not downstream backpressure, so it must
    // not fire: completion stays pending and the upstream is not cancelled.
    // Real timing here mirrors the sibling stalled-stream test — the idle timer is
    // inherently wall-clock, so deterministic fake timers can't exercise it.
    const reader = captured.value.body!.getReader();
    await reader.read();
    const elapsed = delay(120);
    const settled = await Promise.race([captured.completion.then(() => 'settled'), elapsed.then(() => 'pending')]);
    expect(settled).toBe('pending');
    expect(cancelled).toBe(false);

    await reader.cancel();
  });

  test('a hung-open upstream after the terminal frame still trips the idle timeout', async () => {
    // The terminal frame settles the trace as success, but the socket stays open.
    // Trace settlement must not disable the transport idle timer: the next pending
    // read still trips the timeout, cancels upstream, and errors the client stream,
    // while the already-recorded success outcome is preserved.
    let cancelled = false;
    const completedFrame =
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","id":"resp_1","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n';
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(completedFrame));
      },
      pull() {
        return new Promise<void>(() => {}); // never resolves — hung-open after terminal frame
      },
      cancel() {
        cancelled = true;
      },
    });
    const captured = createUsageCapture().passthrough({
      response: new Response(hanging, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
      idleTimeoutMs: 40,
    });

    const reader = captured.value.body!.getReader();
    await reader.read(); // terminal frame

    await expect(reader.read()).rejects.toThrow('stream_idle_timeout');
    expect(cancelled).toBe(true);
    // The success recorded at the terminal frame is preserved (the idle fire did
    // not overwrite it). Usage-value preservation is covered by the terminal
    // early-completion suite, which seeds the price catalog.
    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
  });
});

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
