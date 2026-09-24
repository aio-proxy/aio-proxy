import { describe, expect, spyOn, test } from 'bun:test';

import { openAIResponsesAdapter } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { guardianPayloadHint } from '../../../../plugins/openai-chatgpt/src/runtime/guardian/request';
import { defineProtocolAdapter, jsonRequest, rawProvider, REQUESTED_MODEL } from '../../../__tests__/pipeline-helpers';
import { createObservedFetch } from '../../request-logging';
import { reconstructed, terminals, waitFor } from '../../request-logging/test-support';
import { createRequestTraceRecorder, getTraceRuntime } from '../../request-tracing';
import { toExportableSpan } from '../../request-tracing/otel-export/safe-span';
import { createUsageCapture } from '../../usage-capture';
import { pipeline } from './test-support';

type ObservedCall = {
  body?: string;
  delegated?: string | URL | Request;
  upstream?: Request;
};

function observedProvider(id: string, response: () => Response, call: ObservedCall) {
  const observedFetch = createObservedFetch((async (input) => {
    call.delegated = input;
    if (input instanceof Request) call.body = await input.text();
    return response();
  }) as typeof globalThis.fetch);
  return rawProvider({
    id,
    invoke: async (request) => {
      call.upstream = request;
      return await observedFetch(request);
    },
  });
}

describe('shared protocol pipeline debug logging', () => {
  test('scopes fallback attempts and logs bodies according to real consumption', async () => {
    const inboundPrompt = 'inbound-prompt-sentinel';
    const primaryBody = 'primary-upstream-body-sentinel';
    const backupBody = 'backup-upstream-body-sentinel';
    const primary = observedProvider(
      'primary',
      () => Response.json({ error: { message: primaryBody } }, { status: 503 }),
      {},
    );
    const backup = observedProvider('backup', () => Response.json({ provider: 'backup', message: backupBody }), {});
    const harness = pipeline([primary, backup], { debugLogging: true });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: inboundPrompt }));

    expect(await response.json()).toEqual({ provider: 'backup', message: backupBody });
    await waitFor(() => harness.logs.filter(({ event }) => event.endsWith('_snapshot')).length === 3);
    expect(harness.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'request.inbound_snapshot', requestId: 'request-1' }),
        expect.objectContaining({
          event: 'request.upstream_snapshot',
          requestId: 'request-1',
          attemptIndex: 0,
          providerId: 'primary',
        }),
        expect.objectContaining({
          event: 'request.upstream_snapshot',
          requestId: 'request-1',
          attemptIndex: 1,
          providerId: 'backup',
        }),
      ]),
    );
    expect(reconstructed(harness.logs, 'upstream_request', 0)).toContain(inboundPrompt);
    expect(reconstructed(harness.logs, 'upstream_request', 1)).toContain(inboundPrompt);
    expect(reconstructed(harness.logs, 'inbound')).toContain(inboundPrompt);
    expect(reconstructed(harness.logs, 'upstream_response', 0)).toBe('');
    expect(reconstructed(harness.logs, 'upstream_response', 1)).toContain(backupBody);
    expect(terminals(harness.logs, 'upstream_response')).toContainEqual(
      expect.objectContaining({ attemptIndex: 0, outcome: 'cancelled' }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain(primaryBody);
  });

  test('info logging preserves fetch input identity and emits only the fallback warning', async () => {
    const primaryCall: ObservedCall = {};
    const backupCall: ObservedCall = {};
    const primary = observedProvider('primary', () => Response.json({ error: true }, { status: 503 }), primaryCall);
    const backup = observedProvider('backup', () => Response.json({ provider: 'backup' }), backupCall);
    const harness = pipeline([primary, backup], { debugLogging: false });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(await response.json()).toEqual({ provider: 'backup' });
    expect(primaryCall.delegated).toBe(primaryCall.upstream);
    expect(backupCall.delegated).toBe(backupCall.upstream);
    expect(harness.logs).toEqual([
      expect.objectContaining({
        event: 'request.provider_attempt_failed',
        providerId: 'primary',
        fallback: true,
      }),
    ]);
  });

  test('stalled failure diagnostics cannot delay fallback', async () => {
    let cancelReason: unknown;
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const primary = observedProvider(
      'primary',
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel(reason) {
              cancelReason = reason;
              resolveCancelled();
            },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      {},
    );
    const backup = observedProvider('backup', () => Response.json({ provider: 'backup' }), {});
    const harness = pipeline([primary, backup], { debugLogging: true });
    const pending = harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    const response = await Promise.race([pending, Bun.sleep(50).then(() => undefined)]);
    const cleanupSettled = await Promise.race([cancelled.then(() => true), Bun.sleep(1_500).then(() => false)]);
    await waitFor(() =>
      harness.logs.some(({ event, statusCode }) => event === 'request.upstream_result' && statusCode === 503),
    );

    expect(response).toBeInstanceOf(Response);
    expect(await response?.json()).toEqual({ provider: 'backup' });
    expect(cleanupSettled).toBeTrue();
    expect(cancelReason).toBeUndefined();
    expect(terminals(harness.logs, 'upstream_response')).toContainEqual(
      expect.objectContaining({ attemptIndex: 0, outcome: 'cancelled' }),
    );
    expect(harness.logs).toContainEqual(expect.objectContaining({ event: 'request.upstream_result', statusCode: 503 }));
  });
});

test('sensitive Responses omit all bodies before raw dispatch and across fallback sends', async () => {
  const sentinel = 'guardian-transcript-sentinel';
  let sends = 0;
  let harness: ReturnType<typeof pipeline>;
  const provider = (id: string, status: number) =>
    rawProvider({
      id,
      protocol: ProviderProtocol.OpenAIResponse,
      invoke: async (request) => {
        expect(JSON.stringify(harness.logs)).not.toContain(sentinel);
        const fetch = createObservedFetch((async (input: Request) => {
          expect(await input.text()).toContain(sentinel);
          sends++;
          return Response.json({ id: sentinel, message: sentinel }, { status, headers: { 'x-request-id': sentinel } });
        }) as typeof globalThis.fetch);
        return fetch(request);
      },
    });
  harness = pipeline([provider('primary', 503), provider('backup', 200)], {
    debugLogging: true,
    adapter: defineProtocolAdapter(ProviderProtocol.OpenAIResponse),
  });
  Object.assign(harness.source, {
    preObservationCapturePolicy: async (request, _snapshot, maxBytes) => ({
      capturePayload: (await guardianPayloadHint(request, { maxBytes })) !== 'sensitive',
    }),
  });
  const response = await harness.run(
    jsonRequest({ model: REQUESTED_MODEL, prompt: sentinel, client_metadata: { 'x-openai-subagent': 'guardian' } }),
  );
  expect(await response.text()).toContain(sentinel);
  expect(sends).toBe(2);
  expect(JSON.stringify(harness.logs)).not.toContain(sentinel);
  expect(harness.logs.filter((entry) => entry.event === 'request.body_chunk')).toHaveLength(0);
  expect(terminals(harness.logs, 'inbound')).toContainEqual(expect.objectContaining({ omitted: true }));
});

test('sensitive error codes, headers and response IDs never enter persisted or exported diagnostics', async () => {
  const sentinel = 'private-evaluator-sentinel';
  const stored: unknown[] = [];
  const exported: unknown[] = [];
  const exporter = spyOn(getTraceRuntime().exporter, 'onEnd').mockImplementation((span) => {
    exported.push(toExportableSpan(span));
  });
  const first = rawProvider({
    id: 'first',
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () => {
      expect(JSON.stringify(stored)).not.toContain(sentinel);
      throw Object.assign(new Error(sentinel), { code: sentinel, cause: { code: sentinel }, syscall: sentinel });
    },
  });
  const second = rawProvider({
    id: 'second',
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (request) => {
      expect(JSON.stringify([...stored, ...exported, ...h.logs])).not.toContain(sentinel);
      const fetch = createObservedFetch((async (input: Request) => {
        await input.text();
        return Response.json(
          {
            id: sentinel,
            object: 'response',
            model: 'second-model',
            output: [],
            usage: { input_tokens: 7, output_tokens: 2 },
          },
          { headers: { 'x-request-id': sentinel, 'x-private': sentinel } },
        );
      }) as typeof globalThis.fetch);
      return fetch(request);
    },
  });
  const h = pipeline([first, second], {
    debugLogging: true,
    adapter: defineProtocolAdapter(ProviderProtocol.OpenAIResponse),
  });
  Object.assign(h.source, {
    preObservationCapturePolicy: async () => ({ capturePayload: false }),
    usageCapture: createUsageCapture(),
    requestRecorder: createRequestTraceRecorder({
      store: {
        startRoot: (value) => {
          stored.push(value);
        },
        prune() {},
        recover() {},
        complete: (value) => {
          const { sessionState: _routingState, ...diagnostics } = value;
          stored.push(diagnostics);
          return true;
        },
      },
    }),
  });
  try {
    const response = await h.run(
      new Request('http://localhost/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': sentinel },
        body: JSON.stringify({ model: REQUESTED_MODEL, prompt: sentinel }),
      }),
    );
    expect(await response.text()).toContain(sentinel);
    await waitFor(() => stored.length > 1);
    expect(JSON.stringify([...stored, ...exported, ...h.logs])).not.toContain(sentinel);
    expect(JSON.stringify(stored)).toContain('inputTokens');
    expect(JSON.stringify(stored)).toContain('second');
  } finally {
    exporter.mockRestore();
  }
});

test.each(['malformed', 'oversized', 'not-found', 'policy-error'] as const)(
  'Responses releases its early lease once on %s',
  async (failure) => {
    const h = pipeline([], { adapter: defineProtocolAdapter(ProviderProtocol.OpenAIResponse) });
    let releases = 0;
    const snapshot = h.source.currentProviderSnapshot();
    Object.assign(h.source, {
      acquireProviderSnapshot: () => ({
        snapshot,
        release: () => {
          releases++;
        },
      }),
      preObservationCapturePolicy: async () => {
        if (failure === 'policy-error') throw new Error(failure);
        return { capturePayload: false };
      },
    });
    const request = new Request('http://localhost/responses', {
      method: 'POST',
      body: failure === 'malformed' ? '{' : JSON.stringify({ model: 'missing' }),
      ...(failure === 'oversized' ? { headers: { 'content-length': '999999999' } } : {}),
    });
    try {
      await h.run(request);
    } catch {
      /* failures still release */
    }
    expect(releases).toBe(1);
  },
);

test('Responses keeps the snapshot leased before policy even when policy replaces current routing', async () => {
  const original = rawProvider({ id: 'old', protocol: ProviderProtocol.OpenAIResponse });
  const replacement = rawProvider({ id: 'new', protocol: ProviderProtocol.OpenAIResponse });
  const h = pipeline([original], { adapter: defineProtocolAdapter(ProviderProtocol.OpenAIResponse) });
  const next = pipeline([replacement], { adapter: defineProtocolAdapter(ProviderProtocol.OpenAIResponse) });
  let current = h.source.currentProviderSnapshot();
  let acquired = 0;
  let releases = 0;
  Object.assign(h.source, {
    acquireProviderSnapshot: () => {
      acquired++;
      return {
        snapshot: current,
        release: () => {
          releases++;
        },
      };
    },
    preObservationCapturePolicy: async (_request, snapshot) => {
      expect(snapshot).toBe(current);
      current = next.source.currentProviderSnapshot();
      return { capturePayload: false };
    },
  });
  expect(await (await h.run(jsonRequest({ model: REQUESTED_MODEL }))).json()).toEqual({ provider: 'old' });
  await h.recording.settle();
  expect(acquired).toBe(1);
  expect(releases).toBe(1);
  expect(replacement.calls.raw).toHaveLength(0);
});

test('active hint keeps ordinary Responses body capture while default performs no preflight clone', async () => {
  for (const active of [true, false]) {
    const h = pipeline([rawProvider({ id: 'plain', protocol: ProviderProtocol.OpenAIResponse })], {
      debugLogging: true,
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAIResponse),
    });
    const request = jsonRequest({ model: REQUESTED_MODEL, prompt: 'ordinary-visible-body' });
    let hints = 0;
    const clone = spyOn(request, 'clone');
    Object.assign(h.source, {
      preObservationCapturePolicy: async (raw, _snapshot, maxBytes) => {
        if (!active) {
          expect(clone).not.toHaveBeenCalled();
          return { capturePayload: true };
        }
        hints++;
        return { capturePayload: (await guardianPayloadHint(raw, { maxBytes })) !== 'sensitive' };
      },
    });
    await (await h.run(request)).text();
    expect(hints).toBe(active ? 1 : 0);
    expect(reconstructed(h.logs, 'inbound')).toContain('ordinary-visible-body');
    clone.mockRestore();
  }
});

test('sensitive Responses keeps privacy through raw replay and releases streaming lease on completion', async () => {
  const sentinel = 'private-replay-sentinel';
  let sends = 0;
  let releases = 0;
  let close!: () => void;
  const h = pipeline(
    [
      rawProvider({
        id: 'retry',
        protocol: ProviderProtocol.OpenAIResponse,
        invoke: async (request) => {
          expect(JSON.stringify(h.logs)).not.toContain(sentinel);
          const fetch = createObservedFetch((async (raw: Request) => {
            expect(await raw.text()).toContain(sentinel);
            sends++;
            if (sends === 1)
              return Response.json(
                { error: { code: 'invalid_encrypted_content', message: sentinel } },
                { status: 400 },
              );
            return new Response(
              new ReadableStream({
                start(controller) {
                  const encoder = new TextEncoder();
                  controller.enqueue(
                    encoder.encode(
                      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${sentinel}"}\n\n`,
                    ),
                  );
                  close = () => {
                    controller.enqueue(
                      encoder.encode(
                        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
                      ),
                    );
                    controller.close();
                  };
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }) as typeof globalThis.fetch);
          return fetch(request);
        },
      }),
    ],
    { debugLogging: true, adapter: openAIResponsesAdapter },
  );
  const snapshot = h.source.currentProviderSnapshot();
  Object.assign(h.source, {
    usageCapture: createUsageCapture(),
    acquireProviderSnapshot: () => ({
      snapshot,
      release: () => {
        releases++;
      },
    }),
    preObservationCapturePolicy: async () => ({ capturePayload: false }),
  });
  const response = await h.run(
    jsonRequest({
      model: REQUESTED_MODEL,
      stream: true,
      input: [
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/review',
          content: [{ type: 'encrypted_content', encrypted_content: sentinel }],
        },
      ],
    }),
  );
  expect(sends).toBe(2);
  expect(releases).toBe(0);
  close();
  expect(await response.text()).toContain(sentinel);
  await waitFor(() => releases === 1);
  expect(releases).toBe(1);
  expect(JSON.stringify(h.logs)).not.toContain(sentinel);
  expect(h.logs.filter((entry) => entry.event === 'request.body_chunk')).toHaveLength(0);
});

test('aborting sensitive preflight releases the lease once and invokes no Provider', async () => {
  const provider = rawProvider({ id: 'unused', protocol: ProviderProtocol.OpenAIResponse });
  const h = pipeline([provider], { adapter: openAIResponsesAdapter });
  const snapshot = h.source.currentProviderSnapshot();
  let releases = 0;
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  Object.assign(h.source, {
    acquireProviderSnapshot: () => ({
      snapshot,
      release: () => {
        releases++;
      },
    }),
    preObservationCapturePolicy: async (request, _snapshot, maxBytes) => {
      started.resolve();
      return { capturePayload: (await guardianPayloadHint(request, { maxBytes })) !== 'sensitive' };
    },
  });
  const pending = h.run(
    new Request('http://localhost/responses', {
      method: 'POST',
      signal: controller.signal,
      body: new ReadableStream({ pull() {} }),
    }),
  );
  await started.promise;
  controller.abort();
  await pending.catch(() => undefined);
  expect(releases).toBe(1);
  expect(provider.calls.raw).toHaveLength(0);
});
