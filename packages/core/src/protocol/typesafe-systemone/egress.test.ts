import { describe, expect, it } from 'bun:test';

import type { EvaluationResult } from '../adapter';
import { EvaluationDistributionError, systemOneJson } from './egress';

const context = { responseModelId: 'public-jev' };

describe('systemOneJson', () => {
  it('echoes the requested public slug, not the upstream id', () => {
    const result: EvaluationResult = { answers: { a: { type: 'noul', noul: 0.9 } } };
    expect(systemOneJson(result, context)).toMatchObject({ model: 'public-jev' });
  });

  it('writes probabilities and confidence when present, and never writes legend', () => {
    const result: EvaluationResult = {
      answers: {
        c: { type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 0.8 },
        s: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1 } },
      },
    };
    const body = systemOneJson(result, context) as {
      answers: Record<string, Record<string, unknown>>;
    };
    expect(body.answers['c']).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 1 },
      confidence: 0.8,
    });
    expect(body.answers['s']?.['confidence']).toBeUndefined();
    expect(body.answers['s']?.['legend']).toBeUndefined();
  });

  it('refuses a choice or score answer with no distribution', () => {
    const result: EvaluationResult = { answers: { c: { type: 'choice', choice: 'billing' } } };
    expect(() => systemOneJson(result, context)).toThrow(EvaluationDistributionError);
  });

  it('omits usage entirely when none was reported', () => {
    const result: EvaluationResult = { answers: { a: { type: 'noul', noul: 0.1 } } };
    expect(systemOneJson(result, context)).not.toHaveProperty('usage');
  });

  it('writes snake_case usage when reported', () => {
    const result: EvaluationResult = {
      answers: { a: { type: 'noul', noul: 0.1 } },
      usage: { inputTokens: 312, outputTokens: 48 },
    };
    expect(systemOneJson(result, context)).toMatchObject({
      usage: { input_tokens: 312, output_tokens: 48 },
    });
  });
});
