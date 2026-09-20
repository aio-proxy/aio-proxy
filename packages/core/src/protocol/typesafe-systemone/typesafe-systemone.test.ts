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

  it('projects noul criteria down to true/false for convert', () => {
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(request, {});
    expect(invocation.questions['q']).toEqual({
      type: 'noul',
      instructions: 'i',
      criteria: { true: 't' },
    });
  });

  it('preserves absence rather than creating undefined criteria properties', async () => {
    const bare = await parseSystemOneBody(
      inbound({ ...rawBody, questions: { q: { type: 'noul', instructions: 'i' } } }),
    );
    const invocation = typeSafeSystemOneAdapter.evaluationInvocation(bare, {});
    expect('criteria' in (invocation.questions['q'] as object)).toBe(false);
  });
});
