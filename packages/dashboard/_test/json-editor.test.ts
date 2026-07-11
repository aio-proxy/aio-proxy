import { describe, expect, test } from "bun:test";
import { mergeJsonValidation, parseJsonDraft } from "../src/components/json-editor/json-editor-state";
import { createJsonSchemaRegistry } from "../src/components/json-editor/json-schema-registry";

describe("JsonEditor state", () => {
  test("distinguishes empty, null, valid JSON, and invalid JSON", () => {
    expect(parseJsonDraft("   ")).toEqual({ ok: true, value: undefined });
    expect(parseJsonDraft("null")).toEqual({ ok: true, value: null });
    expect(parseJsonDraft('{"x":1}')).toEqual({ ok: true, value: { x: 1 } });
    expect(parseJsonDraft("[")).toEqual({ ok: false });
  });

  test("supports every JSON root type", () => {
    expect(["true", '"value"', "42", "[]"].map((draft) => parseJsonDraft(draft))).toEqual([
      { ok: true, value: true },
      { ok: true, value: "value" },
      { ok: true, value: 42 },
      { ok: true, value: [] },
    ]);
  });

  test("syntax and schema errors invalidate while warnings do not", () => {
    expect(mergeJsonValidation({ syntaxValid: true, markers: [{ severity: "warning" }] }).valid).toBe(true);
    expect(mergeJsonValidation({ syntaxValid: true, markers: [{ severity: "error" }] }).valid).toBe(false);
    expect(mergeJsonValidation({ syntaxValid: false, markers: [] }).valid).toBe(false);
  });

  test("registry preserves other mounted editor schemas", () => {
    const applied: unknown[] = [];
    const registry = createJsonSchemaRegistry((schemas) => applied.push(schemas));
    const removeA = registry.set("a", { uri: "schema:a", fileMatch: ["model:a"], schema: { type: "object" } });
    registry.set("b", { uri: "schema:b", fileMatch: ["model:b"], schema: { type: "array" } });

    removeA();

    expect(applied.at(-1)).toEqual([{ uri: "schema:b", fileMatch: ["model:b"], schema: { type: "array" } }]);
  });

  test("registry cleanup is idempotent and cannot remove a newer registration", () => {
    const applied: unknown[] = [];
    const registry = createJsonSchemaRegistry((schemas) => applied.push(schemas));
    const removeOld = registry.set("editor", {
      uri: "schema:old",
      fileMatch: ["model:editor"],
      schema: { type: "object" },
    });
    const removeNew = registry.set("editor", {
      uri: "schema:new",
      fileMatch: ["model:editor"],
      schema: { type: "array" },
    });

    removeOld();
    expect(applied.at(-1)).toEqual([{ uri: "schema:new", fileMatch: ["model:editor"], schema: { type: "array" } }]);

    removeNew();
    removeNew();
    expect(applied.at(-1)).toEqual([]);
  });
});
