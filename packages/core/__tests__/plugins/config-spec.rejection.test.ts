import { describe, expect, test } from 'bun:test';

import { zod } from '@aio-proxy/plugin-sdk';

import { validateConfigSpec } from '../../src/plugins/config-spec';

const schema = zod.object({});

describe('validateConfigSpec', () => {
  test('rejects secret placeholders because masking is not a hint policy', () => {
    expect(() =>
      validateConfigSpec({
        schema,
        form: [{ type: 'secret', key: 'token', label: 'Token', placeholder: 'optional hint' }],
      }),
    ).toThrow();
  });

  test.each([
    ['blank key', [{ type: 'text', key: ' ', label: 'Name' }]],
    [
      'duplicate key',
      [
        { type: 'text', key: 'name', label: 'Name' },
        { type: 'text', key: 'name', label: 'Again' },
      ],
    ],
    ['blank label', [{ type: 'text', key: 'name', label: ' ' }]],
    ['untrimmed label', [{ type: 'text', key: 'name', label: ' Name ' }]],
    ['malformed when', [{ type: 'text', key: 'name', label: 'Name', when: { key: 'name' } }]],
    [
      'non-JSON condition',
      [
        { type: 'boolean', key: 'enabled', label: 'Enabled' },
        { type: 'text', key: 'name', label: 'Name', when: { key: 'enabled', equals: Number.POSITIVE_INFINITY } },
      ],
    ],
    ['unknown condition key', [{ type: 'text', key: 'name', label: 'Name', when: { key: 'missing', equals: true } }]],
    [
      'duplicate select values',
      [
        {
          type: 'select',
          key: 'mode',
          label: 'Mode',
          options: [
            { value: 'same', label: 'A' },
            { value: 'same', label: 'B' },
          ],
        },
      ],
    ],
    ['non-JSON default', [{ type: 'json', key: 'value', label: 'Value', defaultValue: BigInt(1) }]],
    ['unknown field type', [{ type: 'file', key: 'path', label: 'Path' }]],
  ])('rejects %s', (_name, form) => {
    expect(() => validateConfigSpec({ schema, form })).toThrow();
  });

  test('requires a schema with callable safeParse and safeParseAsync', () => {
    expect(() => validateConfigSpec({ schema: { safeParse: true, safeParseAsync: true }, form: [] })).toThrow();
  });
});
