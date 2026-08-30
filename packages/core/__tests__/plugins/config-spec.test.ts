import { describe, expect, test } from 'bun:test';

import { zod } from '@aio-proxy/plugin-sdk';

import { validateConfigSpec } from '../../src/plugins/config-spec';

const schema = zod.object({});

describe('validateConfigSpec', () => {
  test('accepts every field type and returns shared secret keys', () => {
    const result = validateConfigSpec({
      schema,
      form: [
        { type: 'text', key: 'name', label: 'Name', placeholder: 'Ada' },
        { type: 'secret', key: 'token', label: 'Token' },
        { type: 'number', key: 'count', label: 'Count' },
        { type: 'boolean', key: 'enabled', label: 'Enabled', defaultValue: true },
        {
          type: 'select',
          key: 'mode',
          label: 'Mode',
          when: { key: 'enabled', equals: true },
          options: [
            { value: 'fast', label: 'Fast' },
            { value: 2, label: 'Two' },
            { value: false, label: 'Off' },
          ],
        },
        { type: 'json', key: 'metadata', label: 'Metadata', defaultValue: { nested: [1, null] } },
      ],
    });

    expect(result.spec.form).toHaveLength(6);
    expect([...result.secretKeys]).toEqual(['token']);
  });

  test('materializes localized form copy into plain data and reads field accessors once', () => {
    let labelReads = 0;
    const field = {
      type: 'select',
      key: 'mode',
      get label() {
        labelReads += 1;
        return { default: 'Mode', 'zh-Hans': '模式' };
      },
      description: { default: 'Choose', 'zh-Hans': '选择' },
      options: [
        {
          value: 'fast',
          label: { default: 'Fast', 'zh-Hans': '快速' },
          description: { default: 'Low latency', 'zh-Hans': '低延迟' },
        },
      ],
    };

    const result = validateConfigSpec({ schema, form: [field] });

    expect(labelReads).toBe(1);
    expect(result.spec.form[0]).not.toBe(field);
    expect(result.spec.form[0]).toEqual({
      type: 'select',
      key: 'mode',
      label: { default: 'Mode', 'zh-Hans': '模式' },
      description: { default: 'Choose', 'zh-Hans': '选择' },
      options: [
        {
          value: 'fast',
          label: { default: 'Fast', 'zh-Hans': '快速' },
          description: { default: 'Low latency', 'zh-Hans': '低延迟' },
        },
      ],
    });
    expect(Object.getPrototypeOf(result.spec.form[0]?.label)).toBe(Object.prototype);
  });

  test('accepts a class-based ConfigSpec and fields', () => {
    class When {
      readonly key = 'enabled';
      readonly equals = true;
    }
    class Option {
      readonly value = 'fast';
      readonly label = 'Fast';
    }
    class EnabledField {
      readonly type = 'boolean';
      readonly key = 'enabled';
      readonly label = 'Enabled';
    }
    class SecretField {
      readonly type = 'secret';
      readonly key = 'token';
      readonly label = 'Token';
    }
    class SelectField {
      readonly type = 'select';
      readonly key = 'mode';
      readonly label = 'Mode';
      readonly when = new When();
      readonly options = [new Option()];
    }
    class Spec {
      readonly schema = schema;
      readonly form = [new EnabledField(), new SecretField(), new SelectField()];
    }

    const result = validateConfigSpec(new Spec());

    expect(result.spec.form).toEqual([
      { type: 'boolean', key: 'enabled', label: 'Enabled' },
      { type: 'secret', key: 'token', label: 'Token' },
      {
        type: 'select',
        key: 'mode',
        label: 'Mode',
        when: { key: 'enabled', equals: true },
        options: [{ value: 'fast', label: 'Fast' }],
      },
    ]);
    expect([...result.secretKeys]).toEqual(['token']);
  });

  test('accepts localized placeholders and rejects invalid localized copy', () => {
    expect(() =>
      validateConfigSpec({
        schema,
        form: [
          {
            type: 'text',
            key: 'name',
            label: { default: 'Name', 'zh-Hans': '名称' },
            placeholder: { default: 'Ada', 'zh-Hans': '小明' },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateConfigSpec({
        schema,
        form: [{ type: 'text', key: 'name', label: { default: 'Name', 'en-us': 'Name' } }],
      }),
    ).toThrow();
  });
});
