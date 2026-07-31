import { ProviderRequestTransformRulesSchema, type ProviderRequestTransformRule } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';

import { parseRequestTransformCondition, serializeRequestTransformCondition } from './mongo-codec';

type Condition = NonNullable<ProviderRequestTransformRule['when']>;

const roundTrip = (when: Condition): Condition => {
  const result = serializeRequestTransformCondition(parseRequestTransformCondition(when));
  ProviderRequestTransformRulesSchema.parse([{ when: result, update: [{ $unset: 'request.body.__codec_probe__' }] }]);
  return result;
};

describe('request transform condition codec', () => {
  test('round-trips body, header, and nested expression conditions', () => {
    const when = {
      $and: [
        { 'request.model': { $regex: '^(?:gpt-.*)$' } },
        { 'request.body.limit': { $gte: 1 } },
        {
          $expr: {
            $eq: [{ $getField: { field: 'x.aio.route', input: '$request.headers' } }, 'blue'],
          },
        },
        {
          $expr: {
            $ne: [{ $ifNull: [{ $getField: { field: 'x-present', input: '$request.headers' } }, null] }, null],
          },
        },
        {
          $expr: {
            $regexMatch: {
              input: { $getField: { field: 'x.team', input: '$original.headers' } },
              regex: '^platform-',
              options: 'i',
            },
          },
        },
        {
          $expr: {
            $gt: [{ $add: ['$request.body.input', 1] }, '$original.body.limit'],
          },
        },
      ],
    } satisfies Condition;

    expect(roundTrip(when)).toEqual(when);
  });

  test('keeps Pattern distinct from Visual Regex', () => {
    const pattern = { 'request.model': { $regex: '^(?:gpt-.*)$' } } satisfies Condition;
    const regex = { 'request.model': { $regex: '^(?:gpt-.*)$', $options: '' } } satisfies Condition;
    const flags = { 'request.model': { $regex: '^gpt-', $options: 'usmi' } } satisfies Condition;

    expect(roundTrip(pattern)).toEqual(pattern);
    expect(roundTrip(regex)).toEqual(regex);
    expect(roundTrip(flags)).toEqual({ 'request.model': { $regex: '^gpt-', $options: 'imsu' } });
  });

  test('round-trips negated groups and existence conditions', () => {
    const when = {
      $nor: [{ 'request.body.debug': { $exists: true } }, { 'original.body.limit': { $lt: 1 } }],
    } satisfies Condition;

    expect(roundTrip(when)).toEqual(when);
  });

  test('rejects unsupported operators and unsafe paths before parsing', () => {
    expect(() => parseRequestTransformCondition({ $where: 'true' })).toThrow();
    expect(() => parseRequestTransformCondition({ ['request.body.__proto__.x']: 1 })).toThrow();
  });

  test('keeps Header Pattern distinct from Header Regex', () => {
    const input = { $getField: { field: 'x.team', input: '$request.headers' } };
    const pattern = {
      $expr: { $regexMatch: { input, regex: '^(?:platform-.*)$' } },
    } satisfies Condition;
    const regex = {
      $expr: { $regexMatch: { input, regex: '^(?:platform-.*)$', options: '' } },
    } satisfies Condition;

    expect(roundTrip(pattern)).toEqual(pattern);
    expect(roundTrip(regex)).toEqual(regex);
  });

  test('round-trips Header comparison literals beginning with $', () => {
    const when = {
      $expr: {
        $eq: [{ $getField: { field: 'x.aio.route', input: '$request.headers' } }, { $literal: '$blue' }],
      },
    } satisfies Condition;

    expect(roundTrip(when)).toEqual(when);
  });
});
