import { describe, expect, it } from 'bun:test';

import { parseSystemOneBody, SystemOneParseError } from './parse';

const post = (body: string, contentType: string | undefined = 'application/json') =>
  new Request('https://proxy.test/v1/systemone', {
    method: 'POST',
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    body,
  });

const valid = {
  model: 'jev-latest',
  state: 'the agent closed the ticket',
  questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } },
};
const withBody = (patch: Record<string, unknown>) => post(JSON.stringify({ ...valid, ...patch }));

describe('parseSystemOneBody accepts', () => {
  it('string, object, and array state', async () => {
    for (const state of ['text', { a: 1 }, [1, 2]]) {
      expect((await parseSystemOneBody(withBody({ state }))).state).toEqual(state);
    }
  });

  it('all three question types', async () => {
    const questions = {
      a: { type: 'noul', instructions: 'i' },
      b: { type: 'choice', instructions: 'i', criteria: { x: 'desc', y: null } },
      c: { type: 'score', instructions: 'i', criteria: ['low', 'high'] },
    };
    expect(Object.keys((await parseSystemOneBody(withBody({ questions }))).questions)).toEqual(['a', 'b', 'c']);
  });

  it('boundary sizes: 255 choice options and 2 or 10 score levels', async () => {
    const criteria = Object.fromEntries([...Array(255)].map((_, i) => [`o${i}`, null]));
    await parseSystemOneBody(withBody({ questions: { q: { type: 'choice', instructions: 'i', criteria } } }));
    for (const levels of [2, 10]) {
      const score = [...Array(levels)].map((_, i) => `l${i}`);
      await parseSystemOneBody(withBody({ questions: { q: { type: 'score', instructions: 'i', criteria: score } } }));
    }
  });

  it('preserves unknown fields at every level', async () => {
    const questions = {
      q: { type: 'noul', instructions: 'i', criteria: { true: 't', weird: 'w' }, extra: 1 },
    };
    const parsed = await parseSystemOneBody(withBody({ questions, topLevelExtra: 'keep' }));
    expect((parsed.body as Record<string, unknown>).topLevelExtra).toBe('keep');
    const q = (parsed.body as { questions: Record<string, Record<string, unknown>> }).questions.q;
    expect(q.extra).toBe(1);
    expect((q.criteria as Record<string, unknown>).weird).toBe('w');
  });

  it('a missing content-type when the body is valid JSON, and a charset parameter', async () => {
    await parseSystemOneBody(post(JSON.stringify(valid), undefined));
    await parseSystemOneBody(post(JSON.stringify(valid), 'application/json; charset=utf-8'));
  });
});

describe('parseSystemOneBody rejects', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['invalid JSON', '{nope'],
    ['a JSON primitive body', '42'],
    ['null state', JSON.stringify({ ...valid, state: null })],
    ['number state', JSON.stringify({ ...valid, state: 1 })],
    ['boolean state', JSON.stringify({ ...valid, state: true })],
    ['an absent state key', JSON.stringify({ model: 'm', questions: valid.questions })],
    ['a missing model', JSON.stringify({ state: 's', questions: valid.questions })],
    ['an empty model', JSON.stringify({ ...valid, model: '' })],
    ['missing questions', JSON.stringify({ model: 'm', state: 's' })],
    ['array questions', JSON.stringify({ ...valid, questions: [] })],
    ['empty questions', JSON.stringify({ ...valid, questions: {} })],
    ['an unknown type', JSON.stringify({ ...valid, questions: { q: { type: 'nope', instructions: 'i' } } })],
    ['missing instructions', JSON.stringify({ ...valid, questions: { q: { type: 'noul' } } })],
    ['null instructions', JSON.stringify({ ...valid, questions: { q: { type: 'noul', instructions: null } } })],
    ['number instructions', JSON.stringify({ ...valid, questions: { q: { type: 'noul', instructions: 1 } } })],
    ['choice without criteria', JSON.stringify({ ...valid, questions: { q: { type: 'choice', instructions: 'i' } } })],
    [
      'empty choice criteria',
      JSON.stringify({
        ...valid,
        questions: { q: { type: 'choice', instructions: 'i', criteria: {} } },
      }),
    ],
    [
      'a non-string non-null criteria value',
      JSON.stringify({
        ...valid,
        questions: { q: { type: 'choice', instructions: 'i', criteria: { a: 5 } } },
      }),
    ],
    [
      'score criteria that is not an array',
      JSON.stringify({
        ...valid,
        questions: { q: { type: 'score', instructions: 'i', criteria: {} } },
      }),
    ],
    [
      'one score level',
      JSON.stringify({
        ...valid,
        questions: { q: { type: 'score', instructions: 'i', criteria: ['only'] } },
      }),
    ],
    [
      'a non-string score level',
      JSON.stringify({
        ...valid,
        questions: { q: { type: 'score', instructions: 'i', criteria: ['a', 2] } },
      }),
    ],
    [
      'a non-finite number nested in state',
      JSON.stringify({ ...valid }).replace('"the agent closed the ticket"', '{"n":1e400}'),
    ],
  ];

  it.each(cases)('%s', async (_label, body) => {
    await expect(parseSystemOneBody(post(body))).rejects.toBeInstanceOf(SystemOneParseError);
  });

  it('256 choice options and 11 score levels', async () => {
    const criteria = Object.fromEntries([...Array(256)].map((_, i) => [`o${i}`, null]));
    await expect(
      parseSystemOneBody(withBody({ questions: { q: { type: 'choice', instructions: 'i', criteria } } })),
    ).rejects.toBeInstanceOf(SystemOneParseError);
    const score = [...Array(11)].map((_, i) => `l${i}`);
    await expect(
      parseSystemOneBody(withBody({ questions: { q: { type: 'score', instructions: 'i', criteria: score } } })),
    ).rejects.toBeInstanceOf(SystemOneParseError);
  });

  it('an unsupported media type even when the body is valid JSON', async () => {
    await expect(parseSystemOneBody(post(JSON.stringify(valid), 'text/plain'))).rejects.toBeInstanceOf(
      SystemOneParseError,
    );
  });
});
