import { describe, expect, it } from 'bun:test';

import { UnsupportedContentEncodingError } from '../request';
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

// JSON.stringify cannot emit Infinity, so a quoted 1e400 marks where the literal belongs.
const nonFinite = (patch: Record<string, unknown>) =>
  JSON.stringify({ ...valid, ...patch }).replace('"1e400"', '1e400');

const withQuestion = (q: Record<string, unknown>) => JSON.stringify({ ...valid, questions: { q } });

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
    const posted = { ...valid, questions, topLevelExtra: 'keep' };
    const parsed = await parseSystemOneBody(post(JSON.stringify(posted)));
    expect((parsed.body as Record<string, unknown>).topLevelExtra).toBe('keep');
    const q = (parsed.body as { questions: Record<string, Record<string, unknown>> }).questions.q;
    expect(q.extra).toBe(1);
    expect((q.criteria as Record<string, unknown>).weird).toBe('w');
    // Raw rewrite forwards `body` verbatim: nothing may be dropped, added, or normalized.
    expect(parsed.body).toEqual(posted);
  });

  it('noul criteria with string labels, keeping undeclared keys', async () => {
    const criteria = { true: 'yes', false: 'no', weird: 'w' };
    const parsed = await parseSystemOneBody(
      withBody({ questions: { q: { type: 'noul', instructions: 'i', criteria } } }),
    );
    const q = (parsed.body as { questions: Record<string, Record<string, unknown>> }).questions.q;
    expect(q.criteria).toEqual(criteria);
  });

  it('noul criteria that omits one or both declared labels', async () => {
    for (const criteria of [{}, { true: 'yes' }, { false: 'no' }]) {
      await parseSystemOneBody(withBody({ questions: { q: { type: 'noul', instructions: 'i', criteria } } }));
    }
  });

  it('a missing content-type when the body is valid JSON, and a charset parameter', async () => {
    await parseSystemOneBody(post(JSON.stringify(valid), undefined));
    await parseSystemOneBody(post(JSON.stringify(valid), 'application/json; charset=utf-8'));
  });
});

describe('parseSystemOneBody rejects', () => {
  // The third element is a substring of the expected message: it pins WHICH guard fired, so a
  // guard whose case a neighbour also catches cannot be deleted or reordered unnoticed.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['invalid JSON', '{nope', 'Request body is not valid JSON'],
    ['a JSON primitive body', '42', 'Request body must be a JSON object'],
    ['null state', JSON.stringify({ ...valid, state: null }), 'state must be a string, object, or array'],
    ['number state', JSON.stringify({ ...valid, state: 1 }), 'state must be a string, object, or array'],
    ['boolean state', JSON.stringify({ ...valid, state: true }), 'state must be a string, object, or array'],
    ['an absent state key', JSON.stringify({ model: 'm', questions: valid.questions }), 'state is required'],
    ['a missing model', JSON.stringify({ state: 's', questions: valid.questions }), 'model must be a nonempty string'],
    ['an empty model', JSON.stringify({ ...valid, model: '' }), 'model must be a nonempty string'],
    ['missing questions', JSON.stringify({ model: 'm', state: 's' }), 'questions must be a nonempty question map'],
    ['array questions', JSON.stringify({ ...valid, questions: [] }), 'questions must be a nonempty question map'],
    // The two rows above share one guard, so they share a message; this row fires a different
    // guard (`ids.length === 0`) and must therefore be distinguishable by message.
    ['empty questions', JSON.stringify({ ...valid, questions: {} }), 'questions must declare at least one question'],
    ['an unknown type', withQuestion({ type: 'nope', instructions: 'i' }), 'q.type must be noul, choice, or score'],
    ['missing instructions', withQuestion({ type: 'noul' }), 'q.instructions must be a string, object, or array'],
    [
      'null instructions',
      withQuestion({ type: 'noul', instructions: null }),
      'q.instructions must be a string, object, or array',
    ],
    [
      'number instructions',
      withQuestion({ type: 'noul', instructions: 1 }),
      'q.instructions must be a string, object, or array',
    ],
    [
      'noul criteria that is not an object',
      withQuestion({ type: 'noul', instructions: 'i', criteria: 5 }),
      'q.criteria must be an object',
    ],
    [
      'a non-string noul criteria.true',
      withQuestion({ type: 'noul', instructions: 'i', criteria: { true: 5 } }),
      'q.criteria.true must be a string',
    ],
    [
      'a non-string noul criteria.false',
      withQuestion({ type: 'noul', instructions: 'i', criteria: { true: 'yes', false: [] } }),
      'q.criteria.false must be a string',
    ],
    [
      'choice without criteria',
      withQuestion({ type: 'choice', instructions: 'i' }),
      'q.criteria must be an option map',
    ],
    [
      'empty choice criteria',
      withQuestion({ type: 'choice', instructions: 'i', criteria: {} }),
      'q.criteria must be nonempty',
    ],
    [
      'a non-string non-null criteria value',
      withQuestion({ type: 'choice', instructions: 'i', criteria: { a: 5 } }),
      'q.criteria.a must be a string or null',
    ],
    [
      'score criteria that is not an array',
      withQuestion({ type: 'score', instructions: 'i', criteria: {} }),
      'q.criteria must be an array',
    ],
    [
      'one score level',
      withQuestion({ type: 'score', instructions: 'i', criteria: ['only'] }),
      'q.criteria needs at least 2 levels',
    ],
    [
      'a non-string score level',
      withQuestion({ type: 'score', instructions: 'i', criteria: ['a', 2] }),
      'q.criteria levels must be strings',
    ],
    [
      'a non-finite number nested in state',
      JSON.stringify({ ...valid }).replace('"the agent closed the ticket"', '{"n":1e400}'),
      'Request body contains a non-finite number',
    ],
    [
      'a non-finite number nested in a questions entry',
      nonFinite({ questions: { q: { type: 'noul', instructions: 'i', weight: '1e400' } } }),
      'Request body contains a non-finite number',
    ],
    [
      'a non-finite number in a top-level unknown field',
      nonFinite({ topLevelExtra: { n: '1e400' } }),
      'Request body contains a non-finite number',
    ],
  ];

  it.each(cases)('%s', async (_label, body, message) => {
    await expect(parseSystemOneBody(post(body))).rejects.toBeInstanceOf(SystemOneParseError);
    await expect(parseSystemOneBody(post(body))).rejects.toThrow(message);
  });

  it('256 choice options and 11 score levels', async () => {
    const criteria = Object.fromEntries([...Array(256)].map((_, i) => [`o${i}`, null]));
    await expect(
      parseSystemOneBody(withBody({ questions: { q: { type: 'choice', instructions: 'i', criteria } } })),
    ).rejects.toThrow('q.criteria supports at most 255 options');
    const score = [...Array(11)].map((_, i) => `l${i}`);
    await expect(
      parseSystemOneBody(withBody({ questions: { q: { type: 'score', instructions: 'i', criteria: score } } })),
    ).rejects.toThrow('q.criteria supports at most 10 levels');
  });

  // 415 covers an unsupported media type as well as an unsupported encoding, so this
  // rejection has to escape unwrapped like the encoding one. A `SystemOneParseError`
  // would be mapped to a 400 that blames JSON this endpoint accepted as written.
  it('an unsupported media type unwrapped, so the pipeline answers 415 rather than 400', async () => {
    const rejection = parseSystemOneBody(post(JSON.stringify(valid), 'text/plain'));
    await expect(rejection).rejects.toBeInstanceOf(UnsupportedContentEncodingError);
    await expect(parseSystemOneBody(post(JSON.stringify(valid), 'text/plain'))).rejects.not.toBeInstanceOf(
      SystemOneParseError,
    );
  });
});

describe('parseSystemOneBody content-encoding', () => {
  const encoded = (body: BodyInit, contentEncoding: string) =>
    new Request('https://proxy.test/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': contentEncoding },
      body,
    });

  it('decodes a gzip body instead of parsing the compressed bytes as JSON', async () => {
    const gzipped = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(valid)));
    expect((await parseSystemOneBody(encoded(gzipped, 'gzip'))).model).toBe('jev-latest');
  });

  it('lets an unsupported encoding escape unwrapped so the pipeline answers 415, not 400', async () => {
    const rejection = parseSystemOneBody(encoded(JSON.stringify(valid), 'compress'));
    await expect(rejection).rejects.toBeInstanceOf(UnsupportedContentEncodingError);
    // A SystemOneParseError here would be mapped to a 400 blaming the caller's JSON
    // and would leave `systemOneErrors.unsupportedContentEncoding` unreachable.
    await expect(parseSystemOneBody(encoded(JSON.stringify(valid), 'compress'))).rejects.not.toBeInstanceOf(
      SystemOneParseError,
    );
  });
});
