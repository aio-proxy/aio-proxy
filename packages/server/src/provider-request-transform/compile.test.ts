import { describe, expect, test } from 'bun:test';

import { compileProviderRequestTransforms } from './compile';

const headerGet = (source: 'original' | 'request', field: string) => ({
  $getField: { field, input: `$${source}.headers` },
});

const headerSet = (field: string, value: unknown) => ({
  $setField: { field, input: '$request.headers', value },
});

describe('compileProviderRequestTransforms', () => {
  test('records body reads, body writes, and generated Header targets per rule and stage', () => {
    const compiled = compileProviderRequestTransforms([
      {
        name: 'body-aware',
        when: {
          $and: [{ 'request.body.limit': { $gt: 10 } }, { $expr: { $eq: ['$original.body.route', 'primary'] } }],
        },
        update: [
          { $set: { 'request.body.limit': { $min: ['$request.body.limit', 10] } } },
          { $set: { 'request.headers': headerSet('x-route', '$original.body.route') } },
          { $unset: 'request.body.debug' },
        ],
      },
      {
        when: { $expr: { $eq: [headerGet('request', 'x-route'), 'primary'] } },
        update: [{ $set: { 'request.headers': headerSet('x-route', 'secondary') } }],
      },
    ]);

    expect(compiled.readsBody).toBe(true);
    expect(compiled.rules.map(({ ruleIndex, name, whenReadsBody }) => ({ ruleIndex, name, whenReadsBody }))).toEqual([
      { ruleIndex: 0, name: 'body-aware', whenReadsBody: true },
      { ruleIndex: 1, name: undefined, whenReadsBody: false },
    ]);
    expect(
      compiled.rules.map((rule) =>
        rule.stages.map(({ stageIndex, readsBody, writesBody, headerTarget }) => ({
          stageIndex,
          readsBody,
          writesBody,
          headerTarget,
        })),
      ),
    ).toEqual([
      [
        { stageIndex: 0, readsBody: true, writesBody: true, headerTarget: undefined },
        { stageIndex: 1, readsBody: true, writesBody: false, headerTarget: 'x-route' },
        { stageIndex: 2, readsBody: false, writesBody: true, headerTarget: undefined },
      ],
      [{ stageIndex: 0, readsBody: false, writesBody: false, headerTarget: 'x-route' }],
    ]);
  });

  test('does not treat Header paths or static literal payloads as body references', () => {
    const compiled = compileProviderRequestTransforms([
      {
        when: { $expr: { $eq: [headerGet('original', 'x-route'), 'primary'] } },
        update: [
          {
            $set: {
              'request.headers': headerSet('x-static', {
                $literal: {
                  'request.body.looks-like-a-path': '$original.body.looks-like-a-reference',
                },
              }),
            },
          },
        ],
      },
    ]);

    expect(compiled.rules[0]?.whenReadsBody).toBe(false);
    expect(compiled.rules[0]?.stages[0]).toMatchObject({
      readsBody: false,
      writesBody: false,
      headerTarget: 'x-static',
    });
  });

  test('marks an unset-only transform as body-dependent', () => {
    const compiled = compileProviderRequestTransforms([{ update: [{ $unset: 'request.body.debug' }] }]);

    expect(compiled.readsBody).toBe(true);
    expect(compiled.rules[0]?.stages[0]).toMatchObject({ readsBody: false, writesBody: true });
  });

  test('requires scalar-null predicates to match existing fields', () => {
    const compiled = compileProviderRequestTransforms([
      { when: { 'request.body.missing': null }, update: [] },
      { when: { 'request.body.missing': { $exists: false } }, update: [] },
    ]);

    expect(compiled.rules[0]?.query.test({ request: { body: {} } })).toBe(false);
    expect(compiled.rules[0]?.query.test({ request: { body: { missing: null } } })).toBe(true);
    expect(compiled.rules[1]?.query.test({ request: { body: {} } })).toBe(true);
  });
});
