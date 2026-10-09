import { expect, test } from 'bun:test';

import { ConfigSchema } from '@aio-proxy/types';

import { createOpenAIDecisionsEvaluate } from './openai-decisions';

function config() {
  const provider = ConfigSchema.parse({
    providers: {
      judge: { kind: 'api', protocol: 'openai-decisions', baseURL: 'https://upstream.test', models: ['judge'] },
    },
  }).providers[0]!;
  if (provider.kind !== 'api') throw new Error('Expected API provider');
  return provider;
}
const invocation = { state: 'Hello', questions: { q: { type: 'noul', instructions: 'Greeting?' } } } as const;

test('refuses a Decisions answer for the wrong question type', async () => {
  const transport = createOpenAIDecisionsEvaluate(config(), {
    fetch: async () =>
      Response.json({
        answers: [
          {
            name: 'q',
            type: 'choice',
            choice: 'yes',
            probabilities: [{ value: 'yes', probability: 1 }],
            confidence: 1,
          },
        ],
      }),
  });
  await expect(transport.evaluate(invocation, { modelId: 'judge' })).rejects.toThrow();
});

test('refuses duplicate answers even when every requested name appears', async () => {
  const transport = createOpenAIDecisionsEvaluate(config(), {
    fetch: async () =>
      Response.json({
        answers: [
          { name: 'q', type: 'predicate', probability: 0.1 },
          { name: 'q', type: 'predicate', probability: 0.9 },
        ],
      }),
  });
  await expect(transport.evaluate(invocation, { modelId: 'judge' })).rejects.toThrow();
});

test('keeps cache subsets and drops null cache details when serving SystemOne', async () => {
  const answers = [{ name: 'q', type: 'predicate', probability: 0.9 }];
  const evaluate = (usage: unknown) =>
    createOpenAIDecisionsEvaluate(config(), { fetch: async () => Response.json({ answers, usage }) }).evaluate(
      invocation,
      { modelId: 'judge' },
    );
  expect(
    (
      await evaluate({
        input_tokens: 100,
        output_tokens: 99,
        input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      })
    ).usage,
  ).toEqual({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 10 });
  expect((await evaluate({ input_tokens: 7, input_tokens_details: { cached_tokens: null } })).usage).toEqual({
    inputTokens: 7,
    outputTokens: 0,
  });
});

test('records native input-only usage even when the upstream includes output tokens', async () => {
  const transport = createOpenAIDecisionsEvaluate(config(), {
    fetch: async () =>
      Response.json({
        answers: [{ name: 'q', type: 'predicate', probability: 0.9 }],
        usage: { input_tokens: 7, output_tokens: 99 },
      }),
  });
  expect((await transport.evaluate(invocation, { modelId: 'judge' })).usage).toEqual({
    inputTokens: 7,
    outputTokens: 0,
  });
});

test('preserves score distributions and choice keys when serving SystemOne', async () => {
  const transport = createOpenAIDecisionsEvaluate(config(), {
    fetch: async (url, init) => {
      expect(await new Request(url, init).json()).toEqual({
        model: 'judge',
        input: '{"issue":"Export fails"}',
        questions: [
          {
            name: 'team',
            type: 'choice',
            instructions: 'Team?',
            choices: [{ value: 'billing', description: 'Payments' }, { value: 'technical' }],
          },
          {
            name: 'severity',
            type: 'score',
            instructions: 'Severity?',
            levels: [{ label: 'Low' }, { label: 'High' }],
          },
        ],
      });
      return Response.json({
        answers: [
          {
            name: 'severity',
            type: 'score',
            score: 0.7,
            probabilities: [
              { value: 0, probability: 0.3 },
              { value: 1, probability: 0.7 },
            ],
            confidence: 0.8,
          },
          {
            name: 'team',
            type: 'choice',
            choice: 'technical',
            probabilities: [
              { value: 'billing', probability: 0.1 },
              { value: 'technical', probability: 0.9 },
            ],
            confidence: 0.9,
          },
        ],
      });
    },
  });
  expect(
    (
      await transport.evaluate(
        {
          state: { issue: 'Export fails' },
          questions: {
            team: { type: 'choice', instructions: 'Team?', criteria: { billing: 'Payments', technical: null } },
            severity: { type: 'score', instructions: 'Severity?', criteria: ['Low', 'High'] },
          },
        },
        { modelId: 'judge' },
      )
    ).answers,
  ).toEqual({
    team: { type: 'choice', choice: 'technical', probabilities: { billing: 0.1, technical: 0.9 }, confidence: 0.9 },
    severity: { type: 'score', score: 0.7, probabilities: { '0': 0.3, '1': 0.7 }, confidence: 0.8 },
  });
});

test('serializes structured evidence arrays and preserves explicit user messages', async () => {
  for (const { state, input } of [
    { state: [{ content: 'evidence' }], input: '[{"content":"evidence"}]' },
    { state: [{ role: 'user', content: 'evidence' }], input: [{ role: 'user', content: 'evidence' }] },
  ]) {
    const transport = createOpenAIDecisionsEvaluate(config(), {
      fetch: async (url, init) => {
        expect((await new Request(url, init).json()).input).toEqual(input);
        return Response.json({ answers: [{ name: 'q', type: 'predicate', probability: 0.9 }] });
      },
    });
    expect((await transport.evaluate({ ...invocation, state }, { modelId: 'judge' })).answers).toEqual({
      q: { type: 'noul', noul: 0.9 },
    });
  }
});
