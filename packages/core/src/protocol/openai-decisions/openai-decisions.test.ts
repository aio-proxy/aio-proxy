import { expect, test } from 'bun:test';

import { EvaluationDistributionError } from '../typesafe-systemone';
import { openAIDecisionsAdapter } from './openai-decisions';

const body = {
  model: 'judge',
  input: 'Hello',
  questions: [{ type: 'predicate', name: '__proto__', instructions: 'Greeting?' }],
};
const raw = (value: unknown, headers: Record<string, string> = {}) =>
  new Request('https://proxy.test/v1/decisions', { method: 'POST', headers, body: JSON.stringify(value) });

test('enforces choice value types and both option count boundaries', async () => {
  const payload = (choices: unknown[]) => ({
    ...body,
    questions: [{ type: 'choice', instructions: 'Pick one', choices }],
  });
  for (const choices of [
    [{ value: 'only' }],
    [{ value: 1 }, { value: 'one' }],
    Array.from({ length: 256 }, (_, index) => ({ value: String(index) })),
  ]) {
    await expect(openAIDecisionsAdapter.parse(raw(payload(choices)))).rejects.toThrow();
  }
  for (const choices of [
    [{ value: true }, { value: 'true' }],
    Array.from({ length: 255 }, (_, index) => ({ value: String(index) })),
  ]) {
    const parsed = await openAIDecisionsAdapter.parse(raw(payload(choices)));
    expect(parsed.questions[0]).toMatchObject({ choices });
  }
});

test('accepts label-only score levels and preserves rubric meaning and response labels', async () => {
  for (const { levels, criteria } of [
    { levels: [{ label: 'Low' }, { label: 'High' }], criteria: ['Low', 'High'] },
    {
      levels: [
        { label: 'Low', description: 'Cosmetic' },
        { label: 'High', description: 'Blocked' },
      ],
      criteria: ['Low: Cosmetic', 'High: Blocked'],
    },
  ]) {
    const payload = {
      model: 'judge',
      input: 'Export fails',
      questions: [{ type: 'score', name: 'severity', instructions: 'Severity?', levels }],
    };
    const original = raw(payload);
    const request = await openAIDecisionsAdapter.parse(original, {});
    expect(await (await openAIDecisionsAdapter.rawRequest(original, request, 'upstream', {})).json()).toEqual({
      ...payload,
      model: 'upstream',
    });
    expect(openAIDecisionsAdapter.evaluationInvocation(request, {}).questions['severity']).toEqual({
      type: 'score',
      instructions: 'Severity?',
      criteria,
    });
    expect(
      openAIDecisionsAdapter.evaluationJson(
        {
          answers: {
            severity: { type: 'score', score: 0.75, probabilities: { '0': 0.25, '1': 0.75 }, confidence: 0.8 },
          },
        },
        { responseModelId: 'judge' },
        request,
      ),
    ).toEqual({
      model: 'judge',
      answers: [
        {
          type: 'score',
          name: 'severity',
          score: 0.75,
          probabilities: [
            { value: 0, label: 'Low', probability: 0.25 },
            { value: 1, label: 'High', probability: 0.75 },
          ],
          confidence: 0.8,
        },
      ],
    });
  }
});

test('rejects score levels without required labels', async () => {
  await expect(
    openAIDecisionsAdapter.parse(
      raw({
        model: 'judge',
        input: 'Export fails',
        questions: [
          { type: 'score', instructions: 'Severity?', levels: [{ description: 'Low' }, { description: 'High' }] },
        ],
      }),
      {},
    ),
  ).rejects.toThrow();
});

test('keeps prototype-like question names as ordinary evaluation data', async () => {
  const request = await openAIDecisionsAdapter.parse(raw(body), {});
  const invocation = openAIDecisionsAdapter.evaluationInvocation(request, {});
  expect(Object.hasOwn(invocation.questions, '__proto__')).toBe(true);
  expect(
    openAIDecisionsAdapter.evaluationJson(
      { answers: Object.fromEntries([['__proto__', { type: 'noul', noul: 0.7 }]]) },
      { responseModelId: 'judge' },
      request,
    ),
  ).toEqual({ model: 'judge', answers: [{ type: 'predicate', name: '__proto__', probability: 0.7 }] });
});

test('decompresses a request and removes stale length and encoding when rewriting the model', async () => {
  const bytes = Bun.gzipSync(JSON.stringify(body));
  const compressed = new Request('https://proxy.test/v1/decisions', {
    method: 'POST',
    headers: { 'content-encoding': 'gzip', 'content-length': String(bytes.length) },
    body: bytes,
  });
  const request = await openAIDecisionsAdapter.parse(compressed, {});
  const rewritten = await openAIDecisionsAdapter.rawRequest(compressed, request, 'upstream', {});
  expect(await rewritten.json()).toEqual({ ...body, model: 'upstream' });
  expect(rewritten.headers.has('content-encoding')).toBe(false);
  expect(rewritten.headers.has('content-length')).toBe(false);
});

test('does not invent a distribution or confidence when evaluation omits them', async () => {
  const request = await openAIDecisionsAdapter.parse(
    raw({
      model: 'judge',
      input: 'Hello',
      questions: [
        { type: 'choice', name: 'q', instructions: 'Team?', choices: [{ value: 'billing' }, { value: 'tech' }] },
      ],
    }),
    {},
  );
  for (const answer of [
    { type: 'choice', choice: '0', confidence: 0.9 },
    { type: 'choice', choice: '0', probabilities: { '0': 0.9, '1': 0.1 } },
    { type: 'choice', choice: '2', probabilities: { '0': 0.9, '1': 0.1 }, confidence: 0.9 },
    { type: 'choice', choice: '0', probabilities: { '0': 0.9 }, confidence: 0.9 },
  ] as const) {
    expect(() =>
      openAIDecisionsAdapter.evaluationJson({ answers: { q: answer } }, { responseModelId: 'judge' }, request),
    ).toThrow(EvaluationDistributionError);
  }
});

test('keeps unnamed questions in request order without inventing wire names', async () => {
  const request = await openAIDecisionsAdapter.parse(
    raw({
      model: 'judge',
      input: 'Hello',
      questions: [
        { type: 'predicate', instructions: 'Greeting?' },
        { type: 'predicate', name: 'named', instructions: 'French?' },
      ],
    }),
    {},
  );
  expect(
    openAIDecisionsAdapter.evaluationJson(
      { answers: { named: { type: 'noul', noul: 0.1 }, __decision_0: { type: 'noul', noul: 0.9 } } },
      { responseModelId: 'judge' },
      request,
    ),
  ).toEqual({
    model: 'judge',
    answers: [
      { type: 'predicate', name: null, probability: 0.9 },
      { type: 'predicate', name: 'named', probability: 0.1 },
    ],
  });
});

test('rejects an incorrect answer type or an out-of-range probability', async () => {
  const request = await openAIDecisionsAdapter.parse(raw(body), {});
  for (const answer of [
    { type: 'noul', noul: 1.1 },
    { type: 'choice', choice: 'yes' },
  ] as const) {
    expect(() =>
      openAIDecisionsAdapter.evaluationJson(
        { answers: Object.fromEntries([['__proto__', answer]]) },
        { responseModelId: 'judge' },
        request,
      ),
    ).toThrow(EvaluationDistributionError);
  }
});

test('retains the meaning of choice values when descriptions are identical', async () => {
  const request = await openAIDecisionsAdapter.parse(
    raw({
      model: 'judge',
      input: 'I live in Paris',
      questions: [
        {
          type: 'choice',
          name: 'city',
          instructions: 'Which city?',
          choices: [
            { value: 'Paris', description: 'city' },
            { value: 'London', description: 'city' },
          ],
        },
      ],
    }),
    {},
  );
  expect(openAIDecisionsAdapter.evaluationInvocation(request, {}).questions['city']).toEqual({
    type: 'choice',
    instructions: 'Which city?',
    criteria: { '0': '"Paris": city', '1': '"London": city' },
  });
});

test('accepts a named question that matches an unnamed question internal key', async () => {
  const request = await openAIDecisionsAdapter.parse(
    raw({
      model: 'judge',
      input: 'Hello',
      questions: [
        { type: 'predicate', instructions: 'Greeting?' },
        { type: 'predicate', name: '__decision_0', instructions: 'French?' },
      ],
    }),
    {},
  );
  const invocation = openAIDecisionsAdapter.evaluationInvocation(request, {});
  expect(Object.keys(invocation.questions)).toHaveLength(2);
  expect(invocation.questions['__decision_0']).toEqual({ type: 'noul', instructions: 'French?' });
});

test('includes a null name on unnamed refusal answers', async () => {
  const request = await openAIDecisionsAdapter.parse(
    raw({ ...body, questions: [{ type: 'predicate', instructions: 'Greeting?' }] }),
    {},
  );
  expect(
    openAIDecisionsAdapter.evaluationJson(
      { answers: { __decision_0: { type: 'refusal' } } },
      { responseModelId: 'judge' },
      request,
    ),
  ).toEqual({ model: 'judge', answers: [{ type: 'refusal', name: null }] });
});

test('rejects input messages without a user role', async () => {
  await expect(openAIDecisionsAdapter.parse(raw({ ...body, input: [{ content: 'evidence' }] }), {})).rejects.toThrow();
});

test('rejects deeply nested extension fields with a protocol-shaped client error', async () => {
  const original = new Request('https://proxy.test/v1/decisions', {
    method: 'POST',
    body: JSON.stringify(body).slice(0, -1) + ',"extra":' + '{"nested":'.repeat(6000) + '0' + '}'.repeat(6000) + '}',
  });
  let failure: unknown;
  try {
    await openAIDecisionsAdapter.parse(original, {});
  } catch (error) {
    failure = error;
  }
  expect(openAIDecisionsAdapter.errors.requestError(failure)?.status).toBe(400);
});

test('includes null names on every unnamed decision answer type', async () => {
  const request = await openAIDecisionsAdapter.parse(
    raw({
      ...body,
      questions: [
        { type: 'predicate', instructions: 'Greeting?' },
        { type: 'choice', instructions: 'Team?', choices: [{ value: 'billing' }, { value: 'tech' }] },
        { type: 'score', instructions: 'Severity?', levels: [{ label: 'Low' }, { label: 'High' }] },
      ],
    }),
    {},
  );
  expect(
    openAIDecisionsAdapter.evaluationJson(
      {
        answers: {
          __decision_0: { type: 'noul', noul: 0.9 },
          __decision_1: { type: 'choice', choice: '0', probabilities: { '0': 0.9, '1': 0.1 }, confidence: 0.8 },
          __decision_2: { type: 'score', score: 0.75, probabilities: { '0': 0.25, '1': 0.75 }, confidence: 0.8 },
        },
      },
      { responseModelId: 'judge' },
      request,
    ),
  ).toMatchObject({
    answers: [
      { type: 'predicate', name: null },
      { type: 'choice', name: null },
      { type: 'score', name: null },
    ],
  });
});
