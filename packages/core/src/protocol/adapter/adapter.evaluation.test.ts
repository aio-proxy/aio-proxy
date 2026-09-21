import { describe, expect, it } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { REQUEST_BODY_LIMITS } from '../request';
import { defineEvaluationProtocolAdapter, isEvaluationProtocolAdapter, type EvaluationResult } from './adapter';

type EvalRequest = { readonly model: string };
type EvalContext = Record<never, never>;

const define = (overrides: Record<string, unknown> = {}) =>
  defineEvaluationProtocolAdapter<EvalRequest, EvalContext>({
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
    ...(overrides as never),
  });

const adapter = define();
const request = { model: 'm' };
const context = {};

describe('defineEvaluationProtocolAdapter', () => {
  it('ignores a wantsStream override but honors a bodyLimits override', () => {
    // Evaluation is non-streaming by contract, so unlike the embedding factory it
    // must drop a wantsStream override even when one sneaks past the type boundary.
    expect(define({ wantsStream: () => true }).wantsStream(request, context)).toBe(false);

    const bodyLimits = { encoded: 11, decoded: 22 };
    // Also the only proof the override spread reaches the factory at all; without it
    // a dead spread would leave the wantsStream assertion passing vacuously on the default.
    expect(define({ bodyLimits: () => bodyLimits }).bodyLimits(new Request('https://x'), context)).toBe(bodyLimits);

    expect(adapter.bodyLimits(new Request('https://x'), context)).toBe(REQUEST_BODY_LIMITS);
  });

  it('is recognized by the capability guard and not confused with embedding', () => {
    expect(isEvaluationProtocolAdapter(adapter)).toBe(true);
    expect(isEvaluationProtocolAdapter({ capability: 'embedding' })).toBe(false);
  });
});
