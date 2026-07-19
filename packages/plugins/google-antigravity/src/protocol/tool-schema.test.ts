import { describe, expect, test } from "bun:test";

import { applyValidatedToolMode, normalizeAntigravityToolSchema, normalizeFunctionDeclarations } from "./tool-schema";

describe("normalizeAntigravityToolSchema", () => {
  test.each([
    {
      name: "$ref",
      input: { $ref: "#/$defs/Target", description: "Destination" },
      expected: { type: "object", description: "Destination (See: Target)" },
    },
    {
      name: "const",
      input: { const: 3 },
      expected: { type: "string", enum: ["3"] },
    },
    {
      name: "numeric and boolean enum",
      input: { type: "number", enum: [1, true, 3] },
      expected: { type: "string", enum: ["1", "true", "3"] },
      description: "Allowed values: 1, true, 3",
    },
    {
      name: "constraints become description hints",
      input: {
        type: "string",
        minLength: 2,
        maxLength: 8,
        exclusiveMinimum: 0,
        exclusiveMaximum: 9,
        pattern: "^[a-z]+$",
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        format: "email",
        default: "a@b.co",
        examples: ["x@y.co"],
        additionalProperties: false,
      },
      expected: { type: "string" },
      description: "Minimum length: 2",
      absent: [
        "minLength",
        "maxLength",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "pattern",
        "minItems",
        "maxItems",
        "uniqueItems",
        "format",
        "default",
        "examples",
        "additionalProperties",
      ],
    },
    {
      name: "allOf",
      input: {
        type: "object",
        properties: { base: { type: "string" } },
        required: ["base"],
        allOf: [
          { properties: { left: { type: "number" } }, required: ["left", "base"] },
          { properties: { right: { type: "boolean" } }, required: ["right"] },
        ],
      },
      expected: {
        type: "object",
        properties: {
          base: { type: "string" },
          left: { type: "number" },
          right: { type: "boolean" },
        },
        required: ["base", "left", "right"],
      },
      absent: ["allOf"],
    },
    {
      name: "anyOf chooses object",
      input: { anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" } } }] },
      expected: { type: "object", properties: { id: { type: "string" }, _: expect.any(Object) }, required: ["_"] },
      description: "Accepts: string, object",
      absent: ["anyOf"],
    },
    {
      name: "oneOf chooses array before scalar",
      input: { oneOf: [{ type: "null" }, { type: "number" }, { type: "array", items: { type: "string" } }] },
      expected: { type: "array", items: { type: "string" } },
      description: "Accepts: null, number, array",
      absent: ["oneOf"],
    },
    {
      name: "type array",
      input: { type: ["null", "string", "number"] },
      expected: { type: "string" },
      description: "Accepts: null, string, number",
    },
    {
      name: "unsupported fields recurse",
      input: {
        type: "object",
        $defs: { Hidden: { type: "string" } },
        $id: "id",
        $schema: "schema",
        $comment: "comment",
        patternProperties: {},
        unevaluatedProperties: false,
        dependentSchemas: {},
        if: {},
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a real thenable
        then: {},
        else: {},
        not: {},
        "x-private": true,
        properties: { child: { type: "string", "x-child": true } },
        required: ["child"],
      },
      expected: { type: "object", properties: { child: { type: "string" } }, required: ["child"] },
    },
    {
      name: "bad required",
      input: { type: "object", properties: { kept: { type: "string" } }, required: ["missing", 1, "kept"] },
      expected: { type: "object", properties: { kept: { type: "string" } }, required: ["kept"] },
    },
    {
      name: "root empty object",
      input: { type: "object", properties: {} },
      expected: {
        type: "object",
        properties: { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } },
        required: ["reason"],
      },
      root: true,
    },
    {
      name: "nested optional object",
      input: { type: "object", properties: { nested: { type: "object", properties: { value: { type: "string" } } } } },
      expected: {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              value: { type: "string" },
              _: { type: "boolean", description: "Optional placeholder" },
            },
            required: ["_"],
          },
          _: { type: "boolean", description: "Optional placeholder" },
        },
        required: ["_"],
      },
    },
  ])("normalizes $name", ({ input, expected, description, absent, root }) => {
    const normalized = normalizeAntigravityToolSchema(input, { root: root ?? false });

    expect(normalized).toMatchObject(expected);
    if (description !== undefined) expect(normalized.description).toContain(description);
    for (const keyword of absent ?? []) expect(JSON.stringify(normalized)).not.toContain(`"${keyword}"`);
  });

  test("does not mutate input and is idempotent", () => {
    const input = {
      type: "object",
      properties: {
        mode: { const: 3, minLength: 1, "x-internal": true },
        target: { $ref: "#/$defs/Target", description: "Destination" },
        nested: { type: "object", properties: { value: { type: ["string", "null"] } } },
      },
      required: ["mode", "missing"],
      $defs: { Target: { type: "string" } },
    };
    const original = structuredClone(input);
    const normalized = normalizeAntigravityToolSchema(input, { root: true });

    expect(input).toEqual(original);
    expect(normalized.required).toEqual(["mode"]);
    expect(normalized.properties?.mode).toMatchObject({ type: "string", enum: ["3"] });
    expect(normalized.properties?.target?.description).toContain("See: Target");
    expect(normalized.properties?.nested?.required).toEqual(["_"]);
    expect(normalizeAntigravityToolSchema(normalized, { root: true })).toEqual(normalized);
  });
});

describe("request tool normalization", () => {
  test("renames every parametersJsonSchema and normalizes declarations without mutation", () => {
    const declarations = [
      { name: "first", parametersJsonSchema: { type: "object", properties: {} } },
      { name: "second", parameters: { type: "object", properties: { value: { const: true } } } },
    ];
    const original = structuredClone(declarations);

    const normalized = normalizeFunctionDeclarations(declarations);

    expect(declarations).toEqual(original);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).not.toHaveProperty("parametersJsonSchema");
    expect(normalized[0]?.parameters).toMatchObject({ required: ["reason"] });
    expect(normalized[1]?.parameters).toMatchObject({ properties: { value: { type: "string", enum: ["true"] } } });
  });

  test.each([{ parameters: null }, { parameters: [] }, { parameters: "schema" }])(
    "rejects invalid declaration parameter schema $parameters",
    ({ parameters }) => {
      expect(() => normalizeFunctionDeclarations([{ name: "invalid", parametersJsonSchema: parameters }])).toThrow(
        TypeError,
      );
    },
  );

  test("sets VALIDATED only for Claude-backed wire models", () => {
    const request = { toolConfig: { functionCallingConfig: { mode: "AUTO", allowedFunctionNames: ["weather"] } } };

    expect(applyValidatedToolMode(request, true)).toEqual({
      toolConfig: { functionCallingConfig: { mode: "VALIDATED", allowedFunctionNames: ["weather"] } },
    });
    expect(applyValidatedToolMode(request, false)).toEqual(request);
    expect(applyValidatedToolMode(request, true)).not.toBe(request);
  });
});
