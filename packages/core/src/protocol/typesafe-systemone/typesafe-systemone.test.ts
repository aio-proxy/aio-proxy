import { describe, expect, it } from 'bun:test';

import { parseSystemOneBody } from './parse';
import { typeSafeSystemOneAdapter } from './typesafe-systemone';

const rawBody = {
  model: 'public-jev',
  state: 's',
  questions: { q: { type: 'noul', instructions: 'i', criteria: { true: 't', weird: 'w' } } },
  topLevelExtra: 'keep',
};

const inbound = (body: unknown): Request =>
  new Request('https://proxy.test/v1/systemone', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// Parsed rather than hand-built: a literal fixture can silently drift from what
// the parser actually produces and then assert nothing about the real pipeline.
const request = await parseSystemOneBody(inbound(rawBody));

describe('typeSafeSystemOneAdapter', () => {
  it('rewrites only model on raw and preserves unknown fields', async () => {
    const upstream = await typeSafeSystemOneAdapter.rawRequest(inbound(rawBody), request, 'jev-latest', {});
    const body = (await upstream.json()) as Record<string, unknown>;
    expect(body['model']).toBe('jev-latest');
    expect(body['topLevelExtra']).toBe('keep');
    expect((body['questions'] as Record<string, Record<string, unknown>>)['q']?.['criteria']).toEqual({
      true: 't',
      weird: 'w',
    });
  });

  it('inherits the inbound abort signal so a client disconnect cancels upstream', async () => {
    const controller = new AbortController();
    const raw = new Request('https://proxy.test/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rawBody),
      signal: controller.signal,
    });
    const upstream = await typeSafeSystemOneAdapter.rawRequest(raw, request, 'jev-latest', {});
    expect(upstream.signal.aborted).toBe(false);
    controller.abort();
    // The raw transport passes no separate signal, so the Request is the only
    // cancellation channel: a fresh signal would strand the upstream call.
    expect(upstream.signal.aborted).toBe(true);
  });

  it('drops content-encoding and content-length, which the re-serialized body invalidates', async () => {
    const raw = new Request('https://proxy.test/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '3' },
      body: JSON.stringify(rawBody),
    });
    const upstream = await typeSafeSystemOneAdapter.rawRequest(raw, request, 'jev-latest', {});
    expect(upstream.headers.get('content-encoding')).toBeNull();
    expect(upstream.headers.get('content-length')).toBeNull();
    expect(upstream.headers.get('content-type')).toBe('application/json');
  });

  it('projects noul criteria down to true/false for convert', () => {
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(request, {});
    expect(invocation.questions['q']).toEqual({
      type: 'noul',
      instructions: 'i',
      criteria: { true: 't' },
    });
  });

  it('keeps both declared labels when both are present', async () => {
    const both = await parseSystemOneBody(
      inbound({
        ...rawBody,
        questions: { q: { type: 'noul', instructions: 'i', criteria: { true: 't', false: 'f', weird: 'w' } } },
      }),
    );
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(both, {});
    expect(invocation.questions['q']).toEqual({
      type: 'noul',
      instructions: 'i',
      criteria: { true: 't', false: 'f' },
    });
  });

  it('drops criteria entirely when only undeclared keys survive projection', async () => {
    const unknownOnly = await parseSystemOneBody(
      inbound({ ...rawBody, questions: { q: { type: 'noul', instructions: 'i', criteria: { weird: 'w' } } } }),
    );
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(unknownOnly, {});
    // An empty `criteria` object would fail the SDK's own boolean-question check,
    // so projection must omit the key rather than emit `{}`.
    expect(invocation.questions['q']).not.toHaveProperty('criteria');
  });

  it('passes state through unchanged for a string, an object, and an array', async () => {
    for (const state of ['text', { nested: { a: 1 } }, [1, 'two', { three: true }]]) {
      const parsed = await parseSystemOneBody(inbound({ ...rawBody, state }));
      expect(typeSafeSystemOneAdapter.evaluationInvocation(parsed, {}).state).toEqual(state);
    }
  });

  it('preserves absence rather than creating undefined criteria properties', async () => {
    const bare = await parseSystemOneBody(
      inbound({ ...rawBody, questions: { q: { type: 'noul', instructions: 'i' } } }),
    );
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(bare, {});
    expect('criteria' in (invocation.questions['q'] as object)).toBe(false);
  });
});
