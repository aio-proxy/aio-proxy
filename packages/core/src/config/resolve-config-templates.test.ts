import { expect, test } from "bun:test";

import { resolveConfigTemplates } from "./resolve-config-templates";

test("returns a plain string without templates unchanged", () => {
  expect(resolveConfigTemplates("plain string", {})).toBe("plain string");
});

test("interpolates a single {{env.NAME}} variable", () => {
  expect(resolveConfigTemplates("Bearer {{env.TOKEN}}", { TOKEN: "secret" })).toBe("Bearer secret");
});

test("interpolates multiple variables within one string", () => {
  expect(resolveConfigTemplates("{{env.SCHEME}}://{{env.HOST}}", { SCHEME: "https", HOST: "api.example.test" })).toBe(
    "https://api.example.test",
  );
});

test("replaces a missing variable with an empty string", () => {
  expect(resolveConfigTemplates("prefix-{{env.MISSING}}-suffix", {})).toBe("prefix--suffix");
});

test("does not recursively re-evaluate a substituted value", () => {
  expect(resolveConfigTemplates("{{env.OUTER}}", { OUTER: "{{env.INNER}}", INNER: "leaked" })).toBe("{{env.INNER}}");
});

test("resolves templates inside array elements", () => {
  expect(resolveConfigTemplates(["{{env.A}}", "literal", "{{env.B}}"], { A: "one", B: "two" })).toEqual([
    "one",
    "literal",
    "two",
  ]);
});

test("leaves object keys and non-string values unchanged", () => {
  const input = { "{{env.KEY}}": 42, flag: true, empty: null };
  expect(resolveConfigTemplates(input, {})).toEqual({ "{{env.KEY}}": 42, flag: true, empty: null });
});

test("leaves non-plain objects unchanged", () => {
  const url = new URL("https://example.test/v1");
  const headers = new Headers({ Authorization: "secret" });
  const date = new Date("2026-01-01T00:00:00.000Z");
  const map = new Map([["TOKEN", "{{env.TOKEN}}"]]);
  const input = { url, headers, date, map };

  const result = resolveConfigTemplates(input, { TOKEN: "secret" }) as typeof input;

  expect(result.url).toBe(url);
  expect(result.headers).toBe(headers);
  expect(result.date).toBe(date);
  expect(result.map).toBe(map);
  expect(result.map.get("TOKEN")).toBe("{{env.TOKEN}}");
});

test("interpolates templates after bare CR and CRLF line breaks", () => {
  expect(resolveConfigTemplates("x\r{{env.TOKEN}}", { TOKEN: "secret" })).toBe("x\rsecret");
  expect(resolveConfigTemplates("x\r\n{{env.TOKEN}}", { TOKEN: "secret" })).toBe("x\r\nsecret");
  expect(resolveConfigTemplates("x\n{{env.TOKEN}}", { TOKEN: "secret" })).toBe("x\nsecret");
});

test("does not mutate the input value", () => {
  const input = Object.freeze({
    nested: Object.freeze({ token: "{{env.TOKEN}}" }),
    list: Object.freeze(["{{env.TOKEN}}"]),
  });

  const result = resolveConfigTemplates(input, { TOKEN: "secret" }) as typeof input;

  expect(result).not.toBe(input);
  expect(result.nested).not.toBe(input.nested);
  expect(result.list).not.toBe(input.list);
  expect(input.nested.token).toBe("{{env.TOKEN}}");
  expect(result.nested.token).toBe("secret");
});

const rejected = [
  "{{uppercase env.TOKEN}}",
  "{{#if env.TOKEN}}yes{{/if}}",
  "{{> partial}}",
  "{{unknown.TOKEN}}",
  "{{env.1TOKEN}}",
  "{{{env.TOKEN}}}",
  "{{! comment}}",
  "{{env/TOKEN}}",
  "{{env.[TOKEN]}}",
  "{{./env.TOKEN}}",
  "{{this.env.TOKEN}}",
  "{{~env.TOKEN}}",
  "{{env.TOKEN~}}",
];

test.each(rejected)("rejects unsupported template syntax: %s", (template) => {
  expect(() => resolveConfigTemplates(template, { TOKEN: "secret" })).toThrow(TypeError);
  try {
    resolveConfigTemplates(template, { TOKEN: "secret" });
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Unsupported config template");
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain(template);
  }
});

test("parser failures omit the original source from the error message", () => {
  const template = "secret-value {{#if";
  expect(() => resolveConfigTemplates(template, {})).toThrow(TypeError);
  try {
    resolveConfigTemplates(template, {});
  } catch (error) {
    expect((error as Error).message).toBe("Unsupported config template");
    expect((error as Error).message).not.toContain("secret-value");
  }
});
