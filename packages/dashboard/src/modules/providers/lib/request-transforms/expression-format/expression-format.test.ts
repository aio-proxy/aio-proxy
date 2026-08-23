import { describe, expect, test } from '@rstest/core';

import { formatRequestTransformExpression } from './expression-format';

describe('Request transform expression preview', () => {
  test('prints arithmetic infix and parenthesizes nested operands', () => {
    expect(
      formatRequestTransformExpression({
        kind: 'func',
        fn: 'multiply',
        args: [
          {
            kind: 'func',
            fn: 'add',
            args: [
              { kind: 'value', value: 1 },
              { kind: 'value', value: 2 },
            ],
          },
          { kind: 'value', value: 3 },
        ],
      }),
    ).toBe('(1 + 2) × 3');
  });

  test('prints non-arithmetic functions with their registry label and call syntax', () => {
    expect(
      formatRequestTransformExpression({
        kind: 'func',
        fn: 'ifNull',
        args: [
          { kind: 'field', field: 'request.body:temperature' },
          { kind: 'value', value: 'fallback' },
        ],
      }),
    ).toBe('IF NULL(request.body.temperature, "fallback")');
  });

  test('prints header fields as bracketed lookups and headerless scopes bare', () => {
    expect(formatRequestTransformExpression({ kind: 'field', field: 'request.header:x-api-key' })).toBe(
      'request.header["x-api-key"]',
    );
    expect(formatRequestTransformExpression({ kind: 'field', field: 'request.body:' })).toBe('request.body');
    expect(formatRequestTransformExpression({ kind: 'field', field: 'request.model' })).toBe('request.model');
  });
});
