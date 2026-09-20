import { describe, expect, it } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { defineEvaluationProtocolAdapter, isEvaluationProtocolAdapter, type EvaluationResult } from './adapter';

const adapter = defineEvaluationProtocolAdapter<{ readonly model: string }, Record<never, never>>({
  protocol: ProviderProtocol.TypeSafeSystemOne,
  parse: async () => ({ model: 'm' }),
  model: (request) => request.model,
  rawRequest: async (raw) => raw,
  evaluationInvocation: () => ({ state: 's', questions: {} }),
  evaluationJson: (result: EvaluationResult, context) => ({
    model: context.responseModelId,
    answers: result.answers,
  }),
  errors: {} as never,
});

describe('defineEvaluationProtocolAdapter', () => {
  it('fills the defaults the shared pipeline reads', () => {
    const request = { model: 'm' };
    const context = {};
    expect(adapter.capability).toBe('evaluation');
    expect(adapter.wantsStream(request, context)).toBe(false);
    expect(adapter.session).toBeUndefined();
    expect(adapter.dimensions(request, context)).toEqual({});
    expect(adapter.requestDiagnostics(request, context)).toEqual([]);
  });

  it('is recognized by the capability guard and not confused with embedding', () => {
    expect(isEvaluationProtocolAdapter(adapter)).toBe(true);
    expect(isEvaluationProtocolAdapter({ capability: 'embedding' })).toBe(false);
  });
});
