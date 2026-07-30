import { describe, expect, test } from 'bun:test';

import {
  ConfigSchema,
  type Provider,
  type ProviderRequestTransformRule,
  ProviderKind,
  ProviderProtocol,
} from '@aio-proxy/types';

import { withAttemptLogContext, withRequestLogContext } from '../request-logging';
import { ProviderRequestTransformError } from './error';
import { createProviderRequestTransformFetch } from './fetch';

type FetchCall = { readonly input: RequestInfo | URL; readonly init: RequestInit | undefined };
type BunFetchInit = RequestInit & { readonly decompress?: boolean };

const headerSet = (field: string, value: unknown) => ({
  $setField: { field, input: '$request.headers', value },
});

const headerUnset = (field: string) => ({
  $unsetField: { field, input: '$request.headers' },
});

function provider(rules: readonly ProviderRequestTransformRule[]): Provider {
  return ConfigSchema.parse({
    providers: {
      primary: {
        baseURL: 'https://provider.test/v1',
        kind: ProviderKind.Api,
        models: ['upstream-model'],
        protocol: ProviderProtocol.OpenAICompatible,
        transforms: { request: rules },
      },
    },
  }).providers[0]!;
}

function recordingFetch(calls: FetchCall[]): typeof globalThis.fetch {
  return (async (input, init) => {
    calls.push({ input, init });
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
}

function withProviderAttempt<T>(
  operation: () => T,
  options: {
    readonly modelId?: string;
    readonly providerId?: string;
    readonly requestedModelId?: string;
    readonly sourceProtocol?: ProviderProtocol;
    readonly targetProtocol?: ProviderProtocol;
  } = {},
): T {
  return withRequestLogContext({ requestId: 'request', debug: false, logger: () => {} }, () =>
    withAttemptLogContext(
      {
        attemptIndex: 0,
        providerId: options.providerId ?? 'primary',
        modelId: options.modelId ?? 'upstream-model',
        requestedModelId: options.requestedModelId ?? 'client-model',
        sourceProtocol: options.sourceProtocol ?? ProviderProtocol.OpenAIResponse,
        targetProtocol: options.targetProtocol ?? ProviderProtocol.OpenAICompatible,
      },
      operation,
    ),
  );
}

function bodyStream(text: string, pulled: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled();
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

function sentRequest(calls: readonly FetchCall[], index = 0): Request {
  const input = calls[index]?.input;
  expect(input).toBeInstanceOf(Request);
  return input as Request;
}

async function captureTransformError(operation: Promise<unknown>): Promise<ProviderRequestTransformError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRequestTransformError);
    return error as ProviderRequestTransformError;
  }
  throw new Error('Expected provider request transform to fail');
}

describe('createProviderRequestTransformFetch', () => {
  test('passes through the exact input and init without complete model-attempt metadata', async () => {
    const calls: FetchCall[] = [];
    const transformedFetch = createProviderRequestTransformFetch(
      provider([{ update: [{ $set: { 'request.headers': headerSet('x-provider-route', 'primary') } }] }]),
      recordingFetch(calls),
    );
    const originalInput = new Request('https://provider.test/v1/chat/completions');
    const originalInit = { headers: { 'x-client': 'unchanged' } };

    await transformedFetch(originalInput, originalInit);

    expect(calls[0]?.input).toBe(originalInput);
    expect(calls[0]?.init).toBe(originalInit);
  });

  test('applies Header-only transforms without reading or replacing the body stream', async () => {
    const calls: FetchCall[] = [];
    let bodyPulls = 0;
    const body = bodyStream('{"limit":20}', () => {
      bodyPulls += 1;
    });
    const transformedFetch = createProviderRequestTransformFetch(
      provider([
        {
          when: {
            $and: [
              { 'provider.id': { $eq: 'primary' } },
              { 'request.model': { $eq: 'upstream-model' } },
              { 'request.requestedModel': { $eq: 'client-model' } },
              { 'request.sourceProtocol': { $eq: ProviderProtocol.OpenAIResponse } },
              { 'request.targetProtocol': { $eq: ProviderProtocol.OpenAICompatible } },
            ],
          },
          update: [{ $set: { 'request.headers': headerSet('x-provider-route', 'primary') } }],
        },
      ]),
      recordingFetch(calls),
    );

    await withProviderAttempt(() =>
      transformedFetch('https://provider.test/v1/chat/completions', {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    const sent = sentRequest(calls);
    expect(bodyPulls).toBe(0);
    expect(sent.body).toBe(body);
    expect(sent.headers.get('x-provider-route')).toBe('primary');
  });

  test('parses and serializes a body once and drops its stale content length', async () => {
    const calls: FetchCall[] = [];
    let bodyReads = 0;
    const transformedFetch = createProviderRequestTransformFetch(
      provider([
        {
          update: [{ $set: { 'request.body.limit': { $min: ['$request.body.limit', 10] } } }],
        },
      ]),
      recordingFetch(calls),
    );

    await withProviderAttempt(() =>
      transformedFetch('https://provider.test/v1/chat/completions', {
        body: bodyStream('{"limit":20}', () => {
          bodyReads += 1;
        }),
        headers: { 'content-length': '999', 'content-type': 'application/json; charset=utf-8' },
        method: 'POST',
      }),
    );

    const sent = sentRequest(calls);
    expect(bodyReads).toBe(1);
    expect(await sent.json()).toEqual({ limit: 10 });
    expect(sent.headers.has('content-length')).toBe(false);
  });

  test('preserves literal-dot Header names through generated set and unset operations', async () => {
    const calls: FetchCall[] = [];
    const transformedFetch = createProviderRequestTransformFetch(
      provider([
        {
          update: [
            { $set: { 'request.headers': headerSet('x.aio.route', 'blue') } },
            { $set: { 'request.headers': headerSet('x.aio.remove', 'red') } },
            { $set: { 'request.headers': headerUnset('x.aio.remove') } },
          ],
        },
      ]),
      recordingFetch(calls),
    );

    await withProviderAttempt(() => transformedFetch('https://provider.test/v1/chat/completions'));

    const sent = sentRequest(calls);
    expect(sent.headers.get('x.aio.route')).toBe('blue');
    expect(sent.headers.has('x.aio.remove')).toBe(false);
  });

  test('preserves Bun decompress when rebuilding a transformed Request', async () => {
    const calls: FetchCall[] = [];
    const transformedFetch = createProviderRequestTransformFetch(
      provider([{ update: [{ $set: { 'request.headers': headerSet('x-provider-route', 'primary') } }] }]),
      recordingFetch(calls),
    );

    await withProviderAttempt(() =>
      transformedFetch('https://provider.test/v1/chat/completions', { decompress: false } as BunFetchInit),
    );

    expect(calls[0]?.init).toEqual({ decompress: false });
  });

  test('rejects body-referencing rules on non-JSON requests before base Fetch', async () => {
    const calls: FetchCall[] = [];
    const transformedFetch = createProviderRequestTransformFetch(
      provider([
        {
          name: 'requires-json',
          when: { 'request.body.limit': { $gt: 10 } },
          update: [{ $set: { 'request.headers': headerSet('x-provider-route', 'primary') } }],
        },
      ]),
      recordingFetch(calls),
    );

    const error = await captureTransformError(
      withProviderAttempt(() =>
        transformedFetch('https://provider.test/v1/chat/completions', {
          body: '{"limit":20}',
          headers: { 'content-type': 'text/plain' },
          method: 'POST',
        }),
      ),
    );

    expect(error).toMatchObject({ code: 'REQUEST_TRANSFORM_BODY_NOT_JSON', ruleIndex: 0, ruleName: 'requires-json' });
    expect(calls).toHaveLength(0);
  });

  test('reports malformed JSON only after a body-independent condition matches', async () => {
    const calls: FetchCall[] = [];
    const transformedFetch = createProviderRequestTransformFetch(
      provider([
        {
          name: 'matched-body-update',
          when: { 'request.method': { $eq: 'POST' } },
          update: [{ $set: { 'request.body.limit': 10 } }],
        },
      ]),
      recordingFetch(calls),
    );

    const error = await captureTransformError(
      withProviderAttempt(() =>
        transformedFetch('https://provider.test/v1/chat/completions', {
          body: '{',
          headers: { 'content-type': 'application/problem+json' },
          method: 'POST',
        }),
      ),
    );

    expect(error).toMatchObject({
      code: 'REQUEST_TRANSFORM_BODY_PARSE_FAILED',
      ruleIndex: 0,
      ruleName: 'matched-body-update',
      stageIndex: 0,
    });
    expect(calls).toHaveLength(0);
  });

  test('does not parse a body-dependent update until its body-independent condition matches', async () => {
    const calls: FetchCall[] = [];
    let unmatchedPulls = 0;
    let matchedPulls = 0;
    const transformedFetch = createProviderRequestTransformFetch(
      provider([
        {
          when: { $expr: { $eq: [{ $getField: { field: 'x-run', input: '$request.headers' } }, 'yes'] } },
          update: [{ $set: { 'request.body.limit': 10 } }],
        },
      ]),
      recordingFetch(calls),
    );

    await withProviderAttempt(() =>
      transformedFetch('https://provider.test/v1/chat/completions', {
        body: bodyStream('not-json', () => {
          unmatchedPulls += 1;
        }),
        headers: { 'content-type': 'text/plain', 'x-run': 'no' },
        method: 'POST',
      }),
    );

    await withProviderAttempt(() =>
      transformedFetch('https://provider.test/v1/chat/completions', {
        body: bodyStream('{"limit":20}', () => {
          matchedPulls += 1;
        }),
        headers: { 'content-type': 'application/json', 'x-run': 'yes' },
        method: 'POST',
      }),
    );

    expect(unmatchedPulls).toBe(0);
    expect(matchedPulls).toBe(1);
    expect(await sentRequest(calls, 1).json()).toEqual({ limit: 10 });
  });

  test('allows unchanged host and rejects rule-owned host changes or removal', async () => {
    const unchangedCalls: FetchCall[] = [];
    const unchangedFetch = createProviderRequestTransformFetch(
      provider([{ update: [{ $set: { 'request.headers': headerSet('x-provider-route', 'primary') } }] }]),
      recordingFetch(unchangedCalls),
    );
    await withProviderAttempt(() =>
      unchangedFetch('https://provider.test/v1/chat/completions', { headers: { host: 'provider.test' } }),
    );
    expect(sentRequest(unchangedCalls).headers.get('host')).toBe('provider.test');

    for (const update of [headerSet('host', 'other.test'), headerUnset('host')]) {
      const calls: FetchCall[] = [];
      const forbiddenFetch = createProviderRequestTransformFetch(
        provider([{ name: 'host-write', update: [{ $set: { 'request.headers': update } }] }]),
        recordingFetch(calls),
      );
      const error = await captureTransformError(
        withProviderAttempt(() =>
          forbiddenFetch('https://provider.test/v1/chat/completions', { headers: { host: 'provider.test' } }),
        ),
      );

      expect(error).toMatchObject({
        code: 'REQUEST_TRANSFORM_HEADER_FORBIDDEN',
        ruleIndex: 0,
        ruleName: 'host-write',
        stageIndex: 0,
      });
      expect(calls).toHaveLength(0);
    }
  });

  test('wraps Request reconstruction failures without retaining the original message or operands', async () => {
    const calls: FetchCall[] = [];
    const transformedFetch = createProviderRequestTransformFetch(
      provider([
        {
          name: 'unsafe-header',
          update: [{ $set: { 'request.headers': headerSet('x-unsafe', 'secret-operand\u0000') } }],
        },
      ]),
      recordingFetch(calls),
    );

    const error = await captureTransformError(
      withProviderAttempt(() => transformedFetch('https://provider.test/v1/chat/completions')),
    );

    expect(error.message).toBe('Provider request transform failed');
    expect(error).toMatchObject({
      code: 'REQUEST_TRANSFORM_REQUEST_REBUILD_FAILED',
      ruleIndex: 0,
      ruleName: 'unsafe-header',
      stageIndex: 0,
    });
    expect('cause' in error).toBe(false);
    expect(JSON.stringify(error)).not.toContain('secret-operand');
    expect(calls).toHaveLength(0);
  });
});
