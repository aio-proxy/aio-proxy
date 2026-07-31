import { describe, expect, test } from 'bun:test';

import type { ProviderRequestTransformRule } from '@aio-proxy/types';

import { compileProviderRequestTransforms } from './compile';
import { ProviderRequestTransformError, providerRequestTransformDiagnostic } from './error';
import { evaluateProviderRequestTransforms, type ProviderRequestTransformInput } from './evaluate';

const headerGet = (source: 'original' | 'request', field: string) => ({
  $getField: { field, input: `$${source}.headers` },
});

const headerSet = (field: string, value: unknown) => ({
  $setField: { field, input: '$request.headers', value },
});

const fixture = (request: Partial<ProviderRequestTransformInput['request']> = {}): ProviderRequestTransformInput => ({
  provider: { id: 'openai', kind: 'api', protocol: 'openai-response' },
  request: {
    model: 'gpt-5',
    requestedModel: 'gpt-5',
    sourceProtocol: 'openai-response',
    targetProtocol: 'openai-response',
    method: 'POST',
    url: 'https://example.com/v1/responses',
    headers: { authorization: 'Bearer secret' },
    ...request,
  },
});

describe('evaluateProviderRequestTransforms', () => {
  test('applies matching rules and stages sequentially with one lazy body load', async () => {
    const compiled = compileProviderRequestTransforms([
      {
        when: { 'request.model': { $regex: '^gpt-' } },
        update: [{ $set: { 'request.headers': headerSet('x-route', 'first') } }],
      },
      {
        name: 'cap-and-route',
        when: { $expr: { $eq: [headerGet('request', 'x-route'), 'first'] } },
        update: [
          { $set: { 'request.body.limit': { $min: ['$request.body.limit', 10] } } },
          { $set: { 'request.body.route': '$original.body.route' } },
          { $set: { 'request.headers': headerSet('x-route', 'last') } },
        ],
      },
    ]);
    const locations: unknown[] = [];

    const output = await evaluateProviderRequestTransforms(compiled, fixture({ headers: {} }), async (location) => {
      locations.push(location);
      return { limit: 20, route: { name: 'original' } };
    });

    expect(output.request.body).toEqual({ limit: 10, route: { name: 'original' } });
    expect(output.request.headers['x-route']).toBe('last');
    expect(output.bodyLoaded).toBe(true);
    expect(output.bodyModified).toBe(true);
    expect(locations).toEqual([{ ruleIndex: 1, ruleName: 'cap-and-route', stageIndex: 0 }]);
    expect(output.lastAppliedLocation).toEqual({ ruleIndex: 1, ruleName: 'cap-and-route', stageIndex: 2 });
    expect(output.headerWriteLocations.get('x-route')).toEqual({
      ruleIndex: 1,
      ruleName: 'cap-and-route',
      stageIndex: 2,
    });
  });

  test('keeps original and current body references isolated between stages', async () => {
    const output = await evaluateProviderRequestTransforms(
      compileProviderRequestTransforms([
        {
          update: [
            { $set: { 'request.body.copy': '$original.body.nested' } },
            { $set: { 'request.body.copy.value': 2 } },
            { $set: { 'request.body.originalValue': '$original.body.nested.value' } },
          ],
        },
      ]),
      fixture(),
      async () => ({ nested: { value: 1 } }),
    );

    expect(output.request.body).toEqual({
      nested: { value: 1 },
      copy: { value: 2 },
      originalValue: 1,
    });
  });

  test('does not load the body for Header-only transforms', async () => {
    let bodyLoads = 0;
    const output = await evaluateProviderRequestTransforms(
      compileProviderRequestTransforms([
        { update: [{ $set: { 'request.headers': headerSet('x-route', 'header-only') } }] },
      ]),
      fixture({ headers: {} }),
      async () => {
        bodyLoads += 1;
        return {};
      },
    );

    expect(bodyLoads).toBe(0);
    expect(output.bodyLoaded).toBe(false);
    expect(output.bodyModified).toBe(false);
    expect(output.request.headers).toEqual({ 'x-route': 'header-only' });
  });
});

describe('provider request transform query behavior', () => {
  test('supports the restricted query operators against the current request', async () => {
    const cases: readonly [string, NonNullable<ProviderRequestTransformRule['when']>][] = [
      ['$and', { $and: [{ 'request.body.score': { $gt: 4 } }, { 'request.model': { $regex: '^gpt-' } }] }],
      ['$or', { $or: [{ 'request.body.score': { $lt: 0 } }, { 'request.body.score': { $eq: 5 } }] }],
      ['$nor', { $nor: [{ 'request.body.score': { $lt: 0 } }, { 'request.body.score': { $gt: 10 } }] }],
      ['$not', { 'request.body.score': { $not: { $lte: 4 } } }],
      ['$eq', { 'request.body.score': { $eq: 5 } }],
      ['$ne', { 'request.body.score': { $ne: 4 } }],
      ['$gt', { 'request.body.score': { $gt: 4 } }],
      ['$gte', { 'request.body.score': { $gte: 5 } }],
      ['$lt', { 'request.body.score': { $lt: 6 } }],
      ['$lte', { 'request.body.score': { $lte: 5 } }],
      ['$in', { 'request.body.score': { $in: [4, 5] } }],
      ['$nin', { 'request.body.score': { $nin: [4, 6] } }],
      ['$exists', { 'request.body.score': { $exists: true } }],
      ['$regex', { 'request.model': { $regex: '^GPT-', $options: 'i' } }],
      ['$expr', { $expr: { $eq: ['$request.body.score', 5] } }],
    ];

    for (const [name, when] of cases) {
      const output = await evaluateProviderRequestTransforms(
        compileProviderRequestTransforms([
          { when, update: [{ $set: { 'request.headers': headerSet('x-match', { $literal: name }) } }] },
        ]),
        fixture({ headers: {} }),
        async () => ({ score: 5 }),
      );
      expect(output.request.headers['x-match']).toBe(name);
    }
  });

  test('does not let missing fields satisfy ordinary comparisons', async () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['$eq', { $eq: 5 }],
      ['$ne', { $ne: 5 }],
      ['$gt', { $gt: 5 }],
      ['$gte', { $gte: 5 }],
      ['$lt', { $lt: 5 }],
      ['$lte', { $lte: 5 }],
      ['$in', { $in: [5] }],
      ['$nin', { $nin: [5] }],
      ['$regex', { $regex: '^value$' }],
      ['$not', { $not: { $eq: 5 } }],
    ];

    for (const [name, condition] of cases) {
      const output = await evaluateProviderRequestTransforms(
        compileProviderRequestTransforms([
          {
            when: { 'request.body.missing': condition },
            update: [{ $set: { 'request.headers': headerSet('x-match', { $literal: name }) } }],
          },
        ]),
        fixture({ headers: {} }),
        async () => ({}),
      );
      expect(output.request.headers['x-match']).toBeUndefined();
    }

    const existsOutput = await evaluateProviderRequestTransforms(
      compileProviderRequestTransforms([
        {
          when: { 'request.body.missing': { $exists: false } },
          update: [{ $set: { 'request.headers': headerSet('x-match', { $literal: '$exists' }) } }],
        },
      ]),
      fixture({ headers: {} }),
      async () => ({}),
    );
    expect(existsOutput.request.headers['x-match']).toBe('$exists');
  });

  test('does not apply scalar-null predicates to missing fields', async () => {
    const compiled = compileProviderRequestTransforms([
      {
        when: { 'request.body.missing': null },
        update: [{ $set: { 'request.headers': headerSet('x-match', 'null') } }],
      },
    ]);

    const missingOutput = await evaluateProviderRequestTransforms(compiled, fixture({ headers: {} }), async () => ({}));
    const nullOutput = await evaluateProviderRequestTransforms(compiled, fixture({ headers: {} }), async () => ({
      missing: null,
    }));

    expect(missingOutput.request.headers['x-match']).toBeUndefined();
    expect(nullOutput.request.headers['x-match']).toBe('null');
  });

  test('lets explicit existence predicates control missing-field behavior', async () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['$not-$exists', { $not: { $exists: true } }],
      ['$exists-and-$ne', { $exists: false, $ne: 5 }],
    ];

    for (const [name, condition] of cases) {
      const output = await evaluateProviderRequestTransforms(
        compileProviderRequestTransforms([
          {
            when: { 'request.body.missing': condition },
            update: [{ $set: { 'request.headers': headerSet('x-match', { $literal: name }) } }],
          },
        ]),
        fixture({ headers: {} }),
        async () => ({}),
      );
      expect(output.request.headers['x-match']).toBe(name);
    }
  });
});

describe('provider request transform errors', () => {
  test('wraps condition expression failures without retaining unsafe error details', async () => {
    const error = await captureTransformError(
      evaluateProviderRequestTransforms(
        compileProviderRequestTransforms([
          {
            name: 'bad-condition',
            when: { $expr: { $gt: [{ $add: ['$request.model', 1] }, 0] } },
            update: [{ $set: { 'request.headers': headerSet('x-match', 'bad') } }],
          },
        ]),
        fixture(),
        async () => ({}),
      ),
    );

    expect(error.message).toBe('Provider request transform failed');
    expect(Object.keys(error).sort()).toEqual(['code', 'ruleIndex', 'ruleName']);
    expect('cause' in error).toBe(false);
    expect(providerRequestTransformDiagnostic(error)).toEqual({
      transformRuleIndex: 0,
      transformRuleName: 'bad-condition',
    });
  });

  test('wraps update expression failures with the stage coordinates only', async () => {
    const error = await captureTransformError(
      evaluateProviderRequestTransforms(
        compileProviderRequestTransforms([
          {
            name: 'bad-update',
            update: [{ $set: { 'request.body.value': { $add: ['$request.body.value', 1] } } }],
          },
        ]),
        fixture(),
        async () => ({ value: 'not-a-number' }),
      ),
    );

    expect(error.message).toBe('Provider request transform failed');
    expect(Object.keys(error).sort()).toEqual(['code', 'ruleIndex', 'ruleName', 'stageIndex']);
    expect('cause' in error).toBe(false);
    expect(providerRequestTransformDiagnostic(error)).toEqual({
      transformRuleIndex: 0,
      transformRuleName: 'bad-update',
      transformStageIndex: 0,
    });
    expect(providerRequestTransformDiagnostic(new Error('unsafe'))).toBeUndefined();
  });

  test('supports safe transform errors before a rule location exists', () => {
    const error = new ProviderRequestTransformError({ code: 'REQUEST_TRANSFORM_REQUEST_REBUILD_FAILED' });

    expect(error.message).toBe('Provider request transform failed');
    expect(Object.keys(error)).toEqual(['code']);
    expect('cause' in error).toBe(false);
    expect(providerRequestTransformDiagnostic(error)).toEqual({});
  });
});

async function captureTransformError(promise: Promise<unknown>): Promise<ProviderRequestTransformError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRequestTransformError);
    return error as ProviderRequestTransformError;
  }
  throw new Error('Expected provider request transform to fail');
}
