import { zod } from "@aio-proxy/plugin-sdk";
import { describe, expect, test } from "bun:test";

import { validateConfigSpec } from "../../src/plugins/config-spec";

const schema = zod.object({});

describe("validateConfigSpec", () => {
  test("accepts every field type and returns shared secret keys", () => {
    const result = validateConfigSpec({
      schema,
      form: [
        { type: "text", key: "name", label: "Name", placeholder: "Ada" },
        { type: "secret", key: "token", label: "Token" },
        { type: "number", key: "count", label: "Count" },
        { type: "boolean", key: "enabled", label: "Enabled", defaultValue: true },
        {
          type: "select",
          key: "mode",
          label: "Mode",
          when: { key: "enabled", equals: true },
          options: [
            { value: "fast", label: "Fast" },
            { value: 2, label: "Two" },
            { value: false, label: "Off" },
          ],
        },
        { type: "json", key: "metadata", label: "Metadata", defaultValue: { nested: [1, null] } },
      ],
    });

    expect(result.spec.form).toHaveLength(6);
    expect([...result.secretKeys]).toEqual(["token"]);
  });

  test("materializes localized form copy into plain data and reads field accessors once", () => {
    let labelReads = 0;
    const field = {
      type: "select",
      key: "mode",
      get label() {
        labelReads += 1;
        return { default: "Mode", "zh-Hans": "模式" };
      },
      description: { default: "Choose", "zh-Hans": "选择" },
      options: [
        {
          value: "fast",
          label: { default: "Fast", "zh-Hans": "快速" },
          description: { default: "Low latency", "zh-Hans": "低延迟" },
        },
      ],
    };

    const result = validateConfigSpec({ schema, form: [field] });

    expect(labelReads).toBe(1);
    expect(result.spec.form[0]).not.toBe(field);
    expect(result.spec.form[0]).toEqual({
      type: "select",
      key: "mode",
      label: { default: "Mode", "zh-Hans": "模式" },
      description: { default: "Choose", "zh-Hans": "选择" },
      options: [
        {
          value: "fast",
          label: { default: "Fast", "zh-Hans": "快速" },
          description: { default: "Low latency", "zh-Hans": "低延迟" },
        },
      ],
    });
    expect(Object.getPrototypeOf(result.spec.form[0]?.label)).toBe(Object.prototype);
  });

  test("accepts localized placeholders and rejects invalid localized copy", () => {
    expect(() =>
      validateConfigSpec({
        schema,
        form: [
          {
            type: "text",
            key: "name",
            label: { default: "Name", "zh-Hans": "名称" },
            placeholder: { default: "Ada", "zh-Hans": "小明" },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateConfigSpec({
        schema,
        form: [{ type: "text", key: "name", label: { default: "Name", "en-us": "Name" } }],
      }),
    ).toThrow();
  });

  test("rejects secret placeholders because masking is not a hint policy", () => {
    expect(() =>
      validateConfigSpec({
        schema,
        form: [{ type: "secret", key: "token", label: "Token", placeholder: "optional hint" }],
      }),
    ).toThrow();
  });

  test.each([
    ["blank key", [{ type: "text", key: " ", label: "Name" }]],
    [
      "duplicate key",
      [
        { type: "text", key: "name", label: "Name" },
        { type: "text", key: "name", label: "Again" },
      ],
    ],
    ["blank label", [{ type: "text", key: "name", label: " " }]],
    ["untrimmed label", [{ type: "text", key: "name", label: " Name " }]],
    ["malformed when", [{ type: "text", key: "name", label: "Name", when: { key: "name" } }]],
    [
      "non-JSON condition",
      [
        { type: "boolean", key: "enabled", label: "Enabled" },
        { type: "text", key: "name", label: "Name", when: { key: "enabled", equals: Number.POSITIVE_INFINITY } },
      ],
    ],
    ["unknown condition key", [{ type: "text", key: "name", label: "Name", when: { key: "missing", equals: true } }]],
    [
      "duplicate select values",
      [
        {
          type: "select",
          key: "mode",
          label: "Mode",
          options: [
            { value: "same", label: "A" },
            { value: "same", label: "B" },
          ],
        },
      ],
    ],
    ["non-JSON default", [{ type: "json", key: "value", label: "Value", defaultValue: BigInt(1) }]],
    ["unknown field type", [{ type: "file", key: "path", label: "Path" }]],
  ])("rejects %s", (_name, form) => {
    expect(() => validateConfigSpec({ schema, form })).toThrow();
  });

  test("requires a schema with callable safeParse and safeParseAsync", () => {
    expect(() => validateConfigSpec({ schema: { safeParse: true, safeParseAsync: true }, form: [] })).toThrow();
  });
});
