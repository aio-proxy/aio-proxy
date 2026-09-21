import { describe, expect, it } from 'bun:test';

import { createAnthropic } from '@ai-sdk/anthropic';
import { APICallError, type Experimental_EvaluationModelV4Result as SdkEvaluationResult } from '@ai-sdk/provider';
import { Experimental_EvaluationMockModelV4 } from 'ai/test';

import { AiSdkProviderError } from '../../error';
import { createProviderV4Evaluate } from './provider-v4';

const providerWith = (model: unknown) => ({ evaluationModel: () => model });

const mock = (options: {
  readonly answers: SdkEvaluationResult['answers'];
  readonly providerMetadata?: SdkEvaluationResult['providerMetadata'];
  readonly usage?: SdkEvaluationResult['usage'];
}) =>
  new Experimental_EvaluationMockModelV4({
    supportedQuestionTypes: ['boolean', 'choice', 'score'],
    doEvaluate: async () => ({
      answers: options.answers,
      warnings: [],
      ...(options.providerMetadata === undefined ? {} : { providerMetadata: options.providerMetadata }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    }),
  });

describe('createProviderV4Evaluate', () => {
  it('sends noul as boolean and maps the answer back to noul', async () => {
    let seen: unknown;
    const model = new Experimental_EvaluationMockModelV4({
      supportedQuestionTypes: ['boolean'],
      doEvaluate: async (options) => {
        seen = options.questions;
        return { answers: { q: { type: 'boolean', probability: 0.97 } }, warnings: [] };
      },
    });
    const transport = createProviderV4Evaluate('p', providerWith(model));
    const result = await transport.evaluate(
      { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
      { modelId: 'm' },
    );
    expect((seen as Record<string, { type: string }>)['q']?.type).toBe('boolean');
    expect(result.answers['q']).toEqual({ type: 'noul', noul: 0.97 });
  });

  it('lifts confidence out of providerMetadata keyed by question id', async () => {
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(
        mock({
          answers: { c: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } } },
          providerMetadata: { typesafe: { confidence: { c: 0.84 } } },
        }),
      ),
    );
    const result = await transport.evaluate(
      {
        state: 's',
        questions: { c: { type: 'choice', instructions: 'i', criteria: { billing: null } } },
      },
      { modelId: 'm' },
    );
    expect(result.answers['c']).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 1 },
      confidence: 0.84,
    });
  });

  it('passes probabilities through and omits them when the provider sends none', async () => {
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(mock({ answers: { s: { type: 'score', score: 1 } } })),
    );
    const result = await transport.evaluate(
      { state: 's', questions: { s: { type: 'score', instructions: 'i', criteria: ['lo', 'hi'] } } },
      { modelId: 'm' },
    );
    expect(result.answers['s']).toEqual({ type: 'score', score: 1 });
  });

  it('omits usage when neither token count is reported', async () => {
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(mock({ answers: { q: { type: 'boolean', probability: 0.5 } } })),
    );
    const result = await transport.evaluate(
      { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
      { modelId: 'm' },
    );
    expect(result).toEqual({ answers: { q: { type: 'noul', noul: 0.5 } } });
  });

  it('maps reported input and output token counts onto usage', async () => {
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(
        mock({
          answers: { q: { type: 'boolean', probability: 0.5 } },
          usage: { inputTokens: 11, outputTokens: 3 },
        }),
      ),
    );
    const result = await transport.evaluate(
      { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
      { modelId: 'm' },
    );
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
  });

  // A half-reported usage must omit the missing key outright rather than emit it as an
  // explicit `undefined`, which would serialize into the response envelope as a null.
  it.each([
    ['input', { inputTokens: 11 }, 'outputTokens'] as const,
    ['output', { outputTokens: 3 }, 'inputTokens'] as const,
  ])('omits the absent token count when only %s is reported', async (_label, usage, absent) => {
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(mock({ answers: { q: { type: 'boolean', probability: 0.5 } }, usage })),
    );
    const result = await transport.evaluate(
      { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
      { modelId: 'm' },
    );
    expect(result.usage).toEqual(usage);
    expect(result.usage).not.toHaveProperty(absent);
  });

  it('degrades to no confidence when providerMetadata has the wrong shape', async () => {
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(
        mock({
          answers: { c: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } } },
          providerMetadata: { typesafe: 'not-an-object' } as unknown as SdkEvaluationResult['providerMetadata'],
        }),
      ),
    );
    const result = await transport.evaluate(
      { state: 's', questions: { c: { type: 'choice', instructions: 'i', criteria: { billing: null } } } },
      { modelId: 'm' },
    );
    expect(result.answers['c']).toEqual({ type: 'choice', choice: 'billing', probabilities: { billing: 1 } });
    expect(result.answers['c']).not.toHaveProperty('confidence');
  });

  it('carries string, object, and array state through to doEvaluate intact', async () => {
    for (const state of ['text', { a: 1 }, [1, 2]]) {
      let seen: unknown;
      const model = new Experimental_EvaluationMockModelV4({
        supportedQuestionTypes: ['boolean'],
        doEvaluate: async (options) => {
          seen = options.state;
          return { answers: { q: { type: 'boolean', probability: 0.5 } }, warnings: [] };
        },
      });
      await createProviderV4Evaluate('p', providerWith(model)).evaluate(
        { state, questions: { q: { type: 'noul', instructions: 'i' } } },
        { modelId: 'm' },
      );
      expect(seen).toEqual(state);
    }
  });

  it('forwards the abort signal to the SDK call', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = createProviderV4Evaluate(
      'p',
      providerWith(mock({ answers: { q: { type: 'boolean', probability: 0.5 } } })),
    );
    await expect(
      transport.evaluate(
        { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
        { modelId: 'm', signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  // A retryable non-abort failure is the only shape that proves `maxRetries: 0`:
  // the SDK checks the abort signal before every attempt, so an aborted call
  // would report one attempt even with retries enabled. It must also be a real
  // `APICallError` — the SDK's `shouldRetry` ignores an `isRetryable` property on
  // a plain Error, so a hand-rolled one would never be retried either way.
  it('does not retry a retryable provider failure: exactly one doEvaluate call', async () => {
    let calls = 0;
    const model = new Experimental_EvaluationMockModelV4({
      supportedQuestionTypes: ['boolean'],
      doEvaluate: async () => {
        calls += 1;
        throw new APICallError({
          message: 'upstream 503',
          url: 'https://example.invalid/evaluate',
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      },
    });
    const transport = createProviderV4Evaluate('p', providerWith(model));
    await expect(
      transport.evaluate({ state: 's', questions: { q: { type: 'noul', instructions: 'i' } } }, { modelId: 'm' }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('throws when the package exposes no evaluationModel', () => {
    expect(() => createProviderV4Evaluate('p', {})).toThrow(/evaluation/);
  });

  // `experimental_evaluate` also accepts a bare model id, which it resolves through the
  // Vercel Gateway. A resolver that returned one would bill the wrong account while still
  // answering correctly, so the transport must refuse it instead of calling the SDK.
  it('rejects a resolver that returns a model id string instead of an instance', async () => {
    const transport = createProviderV4Evaluate('p', providerWith('gpt-4o-mini'));
    await expect(
      transport.evaluate({ state: 's', questions: { q: { type: 'noul', instructions: 'i' } } }, { modelId: 'm' }),
    ).rejects.toThrow(AiSdkProviderError);
  });

  // Every fixture above is a plain object, but a real AI SDK provider factory
  // returns a CALLABLE. An object-only guard rejects the genuine article while
  // all of those doubles keep passing, so this constructs the real package.
  it('accepts a real callable AI SDK provider', () => {
    const provider = createAnthropic({ apiKey: 'test' });

    expect(typeof provider).toBe('function');
    expect(() => createProviderV4Evaluate('p', provider)).not.toThrow();
  });

  // A resolver that reads `this` is the shape a plain-object double cannot catch:
  // extracting `provider.evaluationModel` once and calling it bare drops the
  // receiver, so a class-based provider passes the capability probe and then fails
  // every evaluation. `@ai-sdk/*` packages resolve off a closure and survive that;
  // a class does not, and AGENTS.md admits class instances on capability contracts.
  it('resolves through a class method that reads this', async () => {
    class ClassProvider {
      constructor(private readonly model: Experimental_EvaluationMockModelV4) {}
      evaluationModel(_modelId: string): Experimental_EvaluationMockModelV4 {
        return this.model;
      }
    }
    const transport = createProviderV4Evaluate(
      'p',
      new ClassProvider(mock({ answers: { q: { type: 'boolean', probability: 0.61 } } })),
    );

    const result = await transport.evaluate(
      { state: 's', questions: { q: { type: 'noul', instructions: 'i' } } },
      { modelId: 'm' },
    );

    expect(result.answers['q']).toEqual({ type: 'noul', noul: 0.61 });
  });

  it('still rejects a callable that resolves no evaluation model', () => {
    const callableWithout = Object.assign(() => undefined, { languageModel: () => undefined });
    expect(() => createProviderV4Evaluate('p', callableWithout)).toThrow(AiSdkProviderError);
  });

  it('rejects null and undefined without throwing a TypeError', () => {
    expect(() => createProviderV4Evaluate('p', null)).toThrow(AiSdkProviderError);
    expect(() => createProviderV4Evaluate('p', undefined)).toThrow(AiSdkProviderError);
  });
});
