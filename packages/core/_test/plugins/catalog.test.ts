import { describe, expect, test } from "bun:test";

import { ModelCatalogValidationError, validateModelCatalog } from "../../src/plugins/catalog";

const validCatalog = () => ({
  language: [{ id: "language", displayName: "Language", metadata: { nested: [1, true, null] } }],
  image: [{ id: "image" }],
  embedding: [{ id: "embedding" }],
  speech: [{ id: "speech" }],
  transcription: [{ id: "transcription" }],
  reranking: [{ id: "reranking" }],
});

describe("validateModelCatalog", () => {
  test("accepts and normalizes all six modalities", () => {
    expect(validateModelCatalog(validCatalog())).toEqual(validCatalog());
  });

  test.each(["language", "image", "embedding", "speech", "transcription", "reranking"])(
    "requires the %s modality array",
    (modality) => {
      const catalog = validCatalog() as Record<string, unknown>;
      delete catalog[modality];
      expect(() => validateModelCatalog(catalog)).toThrow(ModelCatalogValidationError);
    },
  );

  test.each([
    ["blank id", { ...validCatalog(), language: [{ id: " " }] }],
    ["duplicate id", { ...validCatalog(), language: [{ id: "same" }, { id: "same" }] }],
    ["non-string display name", { ...validCatalog(), language: [{ id: "id", displayName: 1 }] }],
    ["function metadata", { ...validCatalog(), language: [{ id: "id", metadata: () => {} }] }],
    ["bigint metadata", { ...validCatalog(), language: [{ id: "id", metadata: BigInt(1) }] }],
    ["non-finite metadata", { ...validCatalog(), language: [{ id: "id", metadata: Number.POSITIVE_INFINITY }] }],
  ])("rejects %s without exposing the value", (_name, catalog) => {
    try {
      validateModelCatalog(catalog);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCatalogValidationError);
      expect(error).not.toHaveProperty("cause");
    }
  });

  test("rejects cyclic metadata", () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    expect(() => validateModelCatalog({ ...validCatalog(), language: [{ id: "id", metadata }] })).toThrow(
      ModelCatalogValidationError,
    );
  });
});
