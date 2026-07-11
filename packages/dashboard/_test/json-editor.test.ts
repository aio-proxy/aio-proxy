import { describe, expect, test } from "bun:test";
import { setCodeEditorAriaInvalid } from "../src/components/code-editor/code-editor-accessibility";
import {
  beginJsonValidation,
  completeJsonValidation,
  createJsonEditorModelUri,
  createJsonValidationState,
  mergeJsonValidation,
  parseJsonDraft,
} from "../src/components/json-editor/json-editor-state";
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

  test("validation results retain the schema identity they validated", () => {
    const schema = { type: "object" };

    expect(mergeJsonValidation({ syntaxValid: true, markers: [], schema }).schema).toBe(schema);
  });

  test("ignores a stale validation result after the draft changes", () => {
    const schema = { type: "object" };
    const initial = createJsonValidationState('{"old":true}', schema);
    const current = beginJsonValidation(initial, '{"new":true}', schema);

    expect(completeJsonValidation(current, initial.generation, [{ severity: "error" }])).toBe(current);
    expect(current).toMatchObject({ pending: true, markers: [] });
    expect(mergeJsonValidation({ syntaxValid: true, markers: current.markers, pending: current.pending }).valid).toBe(
      false,
    );
  });

  test("ignores a stale validation result after the schema changes", () => {
    const initial = createJsonValidationState("{}", { required: ["old"] });
    const current = beginJsonValidation(initial, "{}", { required: ["new"] });

    expect(completeJsonValidation(current, initial.generation, [{ severity: "error" }])).toBe(current);
    expect(completeJsonValidation(current, current.generation, [{ severity: "warning" }])).toEqual({
      ...current,
      pending: false,
      markers: [{ severity: "warning" }],
    });
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

  test("duplicate caller ids still produce unique model paths and registry entries", () => {
    const firstModel = createJsonEditorModelUri(":r1:", "duplicate");
    const secondModel = createJsonEditorModelUri(":r2:", "duplicate");
    const applied: unknown[] = [];
    const registry = createJsonSchemaRegistry((schemas) => applied.push(schemas));

    registry.set(firstModel, { uri: `${firstModel}#schema`, fileMatch: [firstModel], schema: {} });
    registry.set(secondModel, { uri: `${secondModel}#schema`, fileMatch: [secondModel], schema: {} });

    expect(firstModel).not.toBe(secondModel);
    expect(applied.at(-1)).toHaveLength(2);
  });

  test("mirrors invalid state and its description onto the wrapper and Monaco textbox", async () => {
    const attributes = new Map<string, string>();
    const textbox = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
    const editor = {
      getDomNode: () => ({ querySelector: () => textbox }),
    };

    setCodeEditorAriaInvalid(editor, true, "options-error");
    expect(attributes.get("aria-invalid")).toBe("true");
    expect(attributes.get("aria-describedby")).toBe("options-error");
    setCodeEditorAriaInvalid(editor, false, undefined);
    expect(attributes.has("aria-invalid")).toBe(false);
    expect(attributes.has("aria-describedby")).toBe(false);

    const codeEditorSource = await Bun.file(`${import.meta.dir}/../src/components/code-editor/code-editor.tsx`).text();
    expect(codeEditorSource).toContain(
      "setCodeEditorAriaInvalid(editor, invalidRef.current, ariaDescribedByRef.current)",
    );
    expect(codeEditorSource).toContain("setCodeEditorAriaInvalid(editorRef.current, invalid, ariaDescribedBy)");
    expect(codeEditorSource).toContain("aria-describedby={ariaDescribedBy}");

    const jsonEditorSource = await Bun.file(`${import.meta.dir}/../src/components/json-editor/json-editor.tsx`).text();
    expect(jsonEditorSource).toContain("onValidate={handleValidationReady}");
    expect(jsonEditorSource).toContain("externalInvalid");
    expect(jsonEditorSource).toContain("ariaDescribedBy={errorDescriptionId}");
    expect(jsonEditorSource).toContain("height={height ?? 240}");
  });
});
