import { ProviderRequestTransformRulesSchema, type ProviderRequestTransformStage } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';

import { parseRequestTransformStages, serializeRequestTransformStages } from './stage-codec';

const roundTrip = (stages: readonly ProviderRequestTransformStage[]): ProviderRequestTransformStage[] => {
  const result = serializeRequestTransformStages(parseRequestTransformStages(stages));
  ProviderRequestTransformRulesSchema.parse([{ update: result }]);
  return result;
};

describe('request transform stage codec', () => {
  test('round-trips body static values through canonical literals', () => {
    const stages = [
      { $set: { 'request.body.string': { $literal: '$request.body.not-a-reference' } } },
      { $set: { 'request.body.array': { $literal: [1, '$two', { nested: true }] } } },
      { $set: { 'request.body.object': { $literal: { key: '$value' } } } },
      { $set: { 'request.body.number': 3 } },
    ] satisfies ProviderRequestTransformStage[];

    expect(roundTrip(stages)).toEqual(stages);
  });

  test('round-trips nested body expressions', () => {
    const stages = [
      { $set: { 'request.body.total': { $add: ['$request.body.input', 1] } } },
      {
        $set: {
          'request.body.label': { $concat: ['$request.body.name', '-ok'] },
        },
      },
      { $set: { 'request.body.upper': { $toUpper: ['$request.body.name'] } } },
      {
        $set: {
          'request.body.values': { $concatArrays: ['$request.body.values', { $literal: [2, 3] }] },
        },
      },
      {
        $set: {
          'request.body.result': {
            $cond: [
              '$request.body.enabled',
              {
                $mergeObjects: [{ $literal: { source: '$literal-source' } }, { $literal: { status: 'ok' } }],
              },
              { $ifNull: ['$original.body.fallback', null] },
            ],
          },
        },
      },
    ] satisfies ProviderRequestTransformStage[];

    expect(roundTrip(stages)).toEqual(stages);
  });

  test('preserves remove, header names with dots, order, duplicates, and empty regex flags', () => {
    const stages = [
      { $unset: 'request.body.temporary' },
      {
        $set: {
          'request.headers': {
            $setField: { field: 'x.aio.route', input: '$request.headers', value: 'blue' },
          },
        },
      },
      {
        $set: {
          'request.headers': {
            $setField: {
              field: 'x.aio.route',
              input: '$request.headers',
              value: { $literal: '$request.body.literal' },
            },
          },
        },
      },
      {
        $set: {
          'request.headers': {
            $unsetField: { field: 'x.aio.route', input: '$request.headers' },
          },
        },
      },
      { $set: { 'request.body.flag': { $literal: { $regex: '^x', $options: '' } } } },
    ] satisfies ProviderRequestTransformStage[];

    expect(roundTrip(stages)).toEqual(stages);
  });

  test('rejects non-canonical stages instead of splitting or normalizing them', () => {
    expect(() => parseRequestTransformStages([{ $set: { 'request.body.a': 1, 'request.body.b': 2 } }])).toThrow();
    expect(() =>
      parseRequestTransformStages([
        {
          $set: {
            'request.headers.x.aio.route': 'blue',
          },
        },
      ]),
    ).toThrow();
    expect(() =>
      parseRequestTransformStages([{ $set: { 'request.body.name': { $toUpper: '$request.body.name' } } }]),
    ).toThrow();
    expect(() => parseRequestTransformStages([{ $set: { 'request.body.items': [1, 2] } }])).toThrow();
  });
});
