import { describe, expect, test } from 'bun:test';

import { ProviderRequestTransformRulesJsonSchema, ProviderTransformsSchema } from './provider-transform';

const unsetBodyField = { $unset: 'request.body.x' };

describe('ProviderTransformsSchema', () => {
  test('accepts ordered body and header transforms', () => {
    const valid = {
      request: [
        {
          name: 'cap-output',
          when: {
            $and: [
              { 'request.model': { $regex: '^gpt-' } },
              { $expr: { $gt: ['$request.body.max_output_tokens', 8192] } },
            ],
          },
          update: [
            {
              $set: {
                'request.body.max_output_tokens': {
                  $min: ['$request.body.max_output_tokens', 8192],
                },
              },
            },
            {
              $set: {
                'request.headers': {
                  $setField: {
                    field: 'x-upstream-model',
                    input: '$request.headers',
                    value: '$request.body.model',
                  },
                },
              },
            },
            { $unset: 'request.body.store' },
          ],
        },
      ],
    };

    expect(ProviderTransformsSchema.parse(valid)).toEqual(valid);
  });

  test.each([
    [{ request: [{ when: { $where: 'return true' }, update: [unsetBodyField] }] }, ['request', 0, 'when', '$where']],
    [
      {
        request: [
          {
            update: [{ $set: { 'request.body.a': 1, 'request.body.b': 2 } }],
          },
        ],
      },
      ['request', 0, 'update', 0, '$set'],
    ],
    [{ request: [{ update: [{ $unset: ['request.body.a'] }] }] }, ['request', 0, 'update', 0, '$unset']],
    [
      {
        request: [{ update: [{ $set: { 'request.headers.x.test': 'x' } }] }],
      },
      ['request', 0, 'update', 0, '$set'],
    ],
    [
      {
        request: [{ update: [{ $set: { 'request.url': 'https://evil.test' } }] }],
      },
      ['request', 0, 'update', 0, '$set'],
    ],
    [
      {
        request: [{ update: [{ $unset: 'request.body.__proto__.polluted' }] }],
      },
      ['request', 0, 'update', 0, '$unset'],
    ],
  ])('rejects unsupported or ambiguous transform %# at the stable path', (input, issuePath) => {
    const result = ProviderTransformsSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toContainEqual(issuePath);
  });

  test.each([[{ $regex: '^gpt-' }], [{ $regex: '[a-z]+', $options: 'imsu' }], [{ $regex: 'literal \\d+' }]])(
    'accepts general JSON-string regex conditions %#',
    (condition) => {
      expect(
        ProviderTransformsSchema.safeParse({
          request: [{ when: { 'request.model': condition }, update: [unsetBodyField] }],
        }).success,
      ).toBe(true);
    },
  );

  test.each([
    [{ $regex: '[' }, '$regex'],
    [{ $regex: 'x', $options: 'ii' }, '$options'],
    [{ $regex: 'x', $options: 'g' }, '$options'],
    [{ $regex: 1 }, '$regex'],
  ])('rejects invalid regex condition %#', (condition, failingKey) => {
    const result = ProviderTransformsSchema.safeParse({
      request: [{ when: { 'request.model': condition }, update: [unsetBodyField] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
        'request',
        0,
        'when',
        'request.model',
        failingKey,
      ]);
    }
  });

  test.each([
    { $add: [1, 2] },
    { $subtract: [2, 1] },
    { $multiply: [2, 3] },
    { $divide: [6, 2] },
    { $mod: [5, 2] },
    { $min: [1, 2, 3] },
    { $max: [1, 2, 3] },
    { $abs: [-1] },
    { $concat: ['a', 'b', 'c'] },
    { $toUpper: ['a'] },
    { $toLower: ['A'] },
    { $cond: [true, 'yes', 'no'] },
    { $ifNull: ['$request.body.x', 0] },
    { $concatArrays: [[1], [2], [3]] },
    { $mergeObjects: [{ a: 1 }, { b: 2 }] },
    { $literal: { $unknown: ['$not-an-expression'] } },
  ])('accepts documented expression %#', (expression) => {
    expect(
      ProviderTransformsSchema.safeParse({
        request: [{ update: [{ $set: { 'request.body.result': expression } }] }],
      }).success,
    ).toBe(true);
  });

  test.each([
    [{ $add: [1] }, 'REQUEST_TRANSFORM_EXPRESSION_ARITY_INVALID'],
    [{ $abs: [1, 2] }, 'REQUEST_TRANSFORM_EXPRESSION_ARITY_INVALID'],
    [{ $concat: ['only-one'] }, 'REQUEST_TRANSFORM_EXPRESSION_ARITY_INVALID'],
    [{ $function: ['return 1'] }, 'REQUEST_TRANSFORM_EXPRESSION_OPERATOR_UNSUPPORTED'],
    ['$environment.secret', 'REQUEST_TRANSFORM_EXPRESSION_OPERATOR_UNSUPPORTED'],
    ['$request.body.constructor.value', 'REQUEST_TRANSFORM_PATH_UNSAFE'],
  ])('rejects unsupported expression %#', (expression, message) => {
    const result = ProviderTransformsSchema.safeParse({
      request: [{ update: [{ $set: { 'request.body.result': expression } }] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContain(message);
  });

  test('accepts the canonical generated header conditions', () => {
    const getCurrentHeader = {
      $getField: { field: 'x-tenant', input: '$request.headers' },
    };
    const getOriginalHeader = {
      $getField: { field: 'x-tenant', input: '$original.headers' },
    };
    const conditions = [
      { $eq: [getCurrentHeader, 'team-a'] },
      {
        $regexMatch: {
          input: getOriginalHeader,
          regex: '^team-',
          options: 'i',
        },
      },
      { $ne: [{ $ifNull: [getCurrentHeader, null] }, null] },
      { $eq: [null, { $ifNull: [getOriginalHeader, null] }] },
    ];

    for (const condition of conditions) {
      expect(
        ProviderTransformsSchema.safeParse({
          request: [{ when: { $expr: condition }, update: [unsetBodyField] }],
        }).success,
      ).toBe(true);
    }
  });

  test.each([
    { $expr: { $getField: { field: 'x-tenant', input: '$request.headers' } } },
    {
      $expr: {
        $eq: [{ $getField: { field: 'X-Tenant', input: '$request.headers' } }, 'team-a'],
      },
    },
    {
      $expr: {
        $eq: [{ $getField: { field: 'bad header', input: '$request.headers' } }, 'team-a'],
      },
    },
    {
      $expr: {
        $eq: [{ $getField: { field: 'x-tenant', input: '$request.body.headers' } }, 'team-a'],
      },
    },
    {
      $expr: {
        $regexMatch: { input: '$request.model', regex: '^gpt-' },
      },
    },
    {
      $expr: {
        $eq: [{ $ifNull: ['$request.body.x', null] }, null],
      },
    },
    {
      $expr: {
        $eq: [{ $getField: { field: 'x-tenant', input: '$request.headers' } }, null],
      },
    },
  ])('rejects non-canonical generated header condition %#', (when) => {
    expect(
      ProviderTransformsSchema.safeParse({
        request: [{ when, update: [unsetBodyField] }],
      }).success,
    ).toBe(false);
  });

  test('accepts canonical header updates including connection-managed names', () => {
    const updates = [
      {
        $set: {
          'request.headers': {
            $setField: {
              field: 'connection',
              input: '$request.headers',
              value: 'keep-alive',
            },
          },
        },
      },
      {
        $set: {
          'request.headers': {
            $unsetField: {
              field: 'x-internal-token',
              input: '$request.headers',
            },
          },
        },
      },
    ];

    expect(ProviderTransformsSchema.safeParse({ request: [{ update: updates }] }).success).toBe(true);
  });

  test.each([
    { $setField: { field: 'X-Tenant', input: '$request.headers', value: 'team-a' } },
    { $setField: { field: 'bad header', input: '$request.headers', value: 'team-a' } },
    { $setField: { field: 'x-tenant', input: '$original.headers', value: 'team-a' } },
    { $setField: { field: 'x-tenant', input: '$request.headers' } },
    { $unsetField: { field: 'x-tenant', input: '$original.headers' } },
    { $unsetField: { field: 'x-tenant', input: '$request.headers', value: 'extra' } },
    '$request.headers',
  ])('rejects non-canonical header update %#', (headerExpression) => {
    expect(
      ProviderTransformsSchema.safeParse({
        request: [{ update: [{ $set: { 'request.headers': headerExpression } }] }],
      }).success,
    ).toBe(false);
  });

  test('rejects response transforms in V1', () => {
    const result = ProviderTransformsSchema.safeParse({ request: [], response: [] });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toContainEqual([]);
  });
});

test('ProviderRequestTransformRulesJsonSchema describes non-empty update arrays', () => {
  const schema = ProviderRequestTransformRulesJsonSchema as {
    type?: string;
    items?: {
      type?: string;
      properties?: { update?: { type?: string; minItems?: number } };
    };
  };

  expect(schema.type).toBe('array');
  expect(schema.items?.type).toBe('object');
  expect(schema.items?.properties?.update).toMatchObject({ type: 'array', minItems: 1 });
});
