import { describe, expect, test } from 'bun:test';

import { applyValidatedToolMode, normalizeAntigravityToolSchema, normalizeFunctionDeclarations } from './tool-schema';
import { normalizeCases } from './tool-schema.test-support';

describe('normalizeAntigravityToolSchema', () => {
  test.each(normalizeCases)('normalizes $name', ({ input, expected, description, absent, root }) => {
    const normalized = normalizeAntigravityToolSchema(input, { root: root ?? false });

    expect(normalized).toMatchObject(expected);
    if (description !== undefined) expect(normalized.description).toContain(description);
    for (const keyword of absent ?? []) expect(JSON.stringify(normalized)).not.toContain(`"${keyword}"`);
  });

  test('does not mutate input and is idempotent', () => {
    const input = {
      type: 'object',
      properties: {
        mode: { const: 3, minLength: 1, 'x-internal': true },
        target: { $ref: '#/$defs/Target', description: 'Destination' },
        nested: { type: 'object', properties: { value: { type: ['string', 'null'] } } },
      },
      required: ['mode', 'missing'],
      $defs: { Target: { type: 'string' } },
    };
    const original = structuredClone(input);
    const normalized = normalizeAntigravityToolSchema(input, { root: true });

    expect(input).toEqual(original);
    expect(normalized.required).toEqual(['mode']);
    expect(normalized.properties?.mode).toMatchObject({ type: 'string', enum: ['3'] });
    expect(normalized.properties?.target?.description).toContain('See: Target');
    expect(normalized.properties?.nested?.required).toEqual(['_']);
    expect(normalizeAntigravityToolSchema(normalized, { root: true })).toEqual(normalized);
  });
});

describe('request tool normalization', () => {
  test('renames every parametersJsonSchema and normalizes declarations without mutation', () => {
    const declarations = [
      { name: 'first', parametersJsonSchema: { type: 'object', properties: {} } },
      { name: 'second', parameters: { type: 'object', properties: { value: { const: true } } } },
    ];
    const original = structuredClone(declarations);

    const normalized = normalizeFunctionDeclarations(declarations);

    expect(declarations).toEqual(original);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).not.toHaveProperty('parametersJsonSchema');
    expect(normalized[0]?.parameters).toMatchObject({ required: ['reason'] });
    expect(normalized[1]?.parameters).toMatchObject({ properties: { value: { type: 'string', enum: ['true'] } } });
  });

  test.each([{ parameters: null }, { parameters: [] }, { parameters: 'schema' }])(
    'rejects invalid declaration parameter schema $parameters',
    ({ parameters }) => {
      expect(() => normalizeFunctionDeclarations([{ name: 'invalid', parametersJsonSchema: parameters }])).toThrow(
        TypeError,
      );
    },
  );

  test('sets VALIDATED only for Claude-backed wire models', () => {
    const request = { toolConfig: { functionCallingConfig: { mode: 'AUTO', allowedFunctionNames: ['weather'] } } };

    expect(applyValidatedToolMode(request, true)).toEqual({
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames: ['weather'] } },
    });
    expect(applyValidatedToolMode(request, false)).toEqual(request);
    expect(applyValidatedToolMode(request, true)).not.toBe(request);
  });
});
